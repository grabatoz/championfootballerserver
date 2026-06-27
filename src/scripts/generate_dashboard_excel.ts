import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';
import * as XLSX from 'xlsx';

// Target League
const TARGET_LEAGUE_ID = '560f68b4-86f9-49be-b60f-f5391f7b26e4';
const TARGET_LEAGUE_NAME = 'Season 7 FNF';

// Weights for % Win Influence calculation
const WEIGHTS = { goals: 0.3, assists: 0.2, cleanSheets: 0.2, defensiveImpact: 0.1, motmVotes: 0.2 };

interface PlayerRow {
  id: string;
  firstName: string;
  lastName: string;
  position: string;
  xp: number;
}

interface PlayerAggregated {
  player: PlayerRow;
  matches: number;
  wins: number;
  draws: number;
  losses: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  motmVotes: number;
  defensiveImpactVotes: number;
  sumImpact: number;
  impactCount: number;
  // For Top Strengths (max single match)
  maxSingleGoals: number;
  maxSingleAssists: number;
  maxSingleMotmVotes: number;
  // For Win Influence
  wonGoals: number;
  wonAssists: number;
  wonCleanSheets: number;
  wonDefensiveImpact: number;
  wonMotmVotes: number;
}

async function run() {
  try {
    console.log(`Generating comprehensive PD Excel for ${TARGET_LEAGUE_NAME}...`);

    // 1. Fetch players
    const players: any[] = await sequelize.query(`
      SELECT DISTINCT u.id, u."firstName", u."lastName", u.position, u."xp"
      FROM "users" u
      JOIN "LeagueMember" lm ON lm."userId" = u.id
      WHERE lm."leagueId" = :leagueId
        AND (u.provider IS NULL OR u.provider != 'guest')
        AND u.email IS NOT NULL AND u.email != ''
        AND u.email NOT ILIKE '%guest%'
        AND u.email NOT ILIKE '%@local.invalid'
        AND (u."firstName" IS NULL OR u."firstName" NOT ILIKE 'guest')
        AND u."firstName" IS NOT NULL AND TRIM(u."firstName") != ''
        AND u."firstName" NOT ILIKE '%dummy%'
      ORDER BY u."firstName" ASC, u."lastName" ASC
    `, { replacements: { leagueId: TARGET_LEAGUE_ID }, type: QueryTypes.SELECT });
    console.log(`Found ${players.length} registered players.`);

    // 2. Fetch matches
    const allMatches: any[] = await sequelize.query(`
      SELECT id, date, "homeTeamGoals", "awayTeamGoals",
             "homeDefensiveImpactId", "awayDefensiveImpactId", "leagueId"
      FROM "Matches"
      WHERE status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
        AND "leagueId" = :leagueId
    `, { replacements: { leagueId: TARGET_LEAGUE_ID }, type: QueryTypes.SELECT });
    console.log(`Found ${allMatches.length} completed matches.`);

    const matchMap = new Map<string, any>();
    allMatches.forEach(m => matchMap.set(String(m.id), {
      id: String(m.id), date: m.date,
      homeTeamGoals: Number(m.homeTeamGoals || 0),
      awayTeamGoals: Number(m.awayTeamGoals || 0),
      homeDefensiveImpactId: m.homeDefensiveImpactId ? String(m.homeDefensiveImpactId) : null,
      awayDefensiveImpactId: m.awayDefensiveImpactId ? String(m.awayDefensiveImpactId) : null,
      leagueId: String(m.leagueId)
    }));
    const matchIds = allMatches.map(m => String(m.id));
    if (!matchIds.length) { console.log("No matches. Exiting."); process.exit(0); }

    // 3. Lineups
    const homeLineups: any[] = await sequelize.query(
      `SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT });
    const awayLineups: any[] = await sequelize.query(
      `SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT });

    const playerMatchTeam = new Map<string, 'home' | 'away'>();
    const playerMatches = new Map<string, Set<string>>();
    const addPM = (pId: string, mId: string, team: 'home' | 'away') => {
      playerMatchTeam.set(`${mId}_${pId}`, team);
      if (!playerMatches.has(pId)) playerMatches.set(pId, new Set());
      playerMatches.get(pId)!.add(mId);
    };
    homeLineups.forEach(r => addPM(String(r.userId), String(r.matchId), 'home'));
    awayLineups.forEach(r => addPM(String(r.userId), String(r.matchId), 'away'));

    // 4. Match Statistics
    const stats: any[] = await sequelize.query(
      `SELECT user_id, match_id, goals, assists, clean_sheets, defence, impact, xp_awarded
       FROM "match_statistics" WHERE match_id IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT });

    const matchStatsMap = new Map<string, Map<string, any>>();
    stats.forEach(s => {
      const mId = String(s.match_id), pId = String(s.user_id);
      if (!matchStatsMap.has(mId)) matchStatsMap.set(mId, new Map());
      matchStatsMap.get(mId)!.set(pId, {
        goals: Number(s.goals || 0), assists: Number(s.assists || 0),
        cleanSheets: Number(s.clean_sheets || 0), defence: Number(s.defence || 0),
        impact: Number(s.impact || 0), xpAwarded: Number(s.xp_awarded || 0)
      });
    });

    // 5. MOTM Votes
    const votes: any[] = await sequelize.query(
      `SELECT "matchId", "votedForId" FROM "Votes" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT });
    // Per match per player vote count
    const motmVotesMap = new Map<string, Map<string, number>>();
    votes.forEach(v => {
      const mId = String(v.matchId), pId = String(v.votedForId);
      if (!motmVotesMap.has(mId)) motmVotesMap.set(mId, new Map());
      const pv = motmVotesMap.get(mId)!;
      pv.set(pId, (pv.get(pId) || 0) + 1);
    });

    // 6. Compute league-wide winning totals (for Win Influence)
    const leagueWinTotals = { goals: 0, assists: 0, cleanSheets: 0, defensiveImpact: 0, motmVotes: 0 };
    allMatches.forEach(m => {
      const mId = String(m.id);
      const hG = Number(m.homeTeamGoals || 0), aG = Number(m.awayTeamGoals || 0);
      if (hG === aG) return;
      const winTeam = hG > aG ? 'home' : 'away';
      const lineup = winTeam === 'home' ? homeLineups : awayLineups;
      lineup.filter(r => String(r.matchId) === mId).forEach(r => {
        const pId = String(r.userId);
        const ps = matchStatsMap.get(mId)?.get(pId);
        if (ps) { leagueWinTotals.goals += ps.goals; leagueWinTotals.assists += ps.assists; leagueWinTotals.cleanSheets += ps.cleanSheets; }
        leagueWinTotals.motmVotes += (motmVotesMap.get(mId)?.get(pId) || 0);
        const isDI = (winTeam === 'home' && String(m.homeDefensiveImpactId) === pId) || (winTeam === 'away' && String(m.awayDefensiveImpactId) === pId);
        if (isDI) leagueWinTotals.defensiveImpact++;
      });
    });

    // 7. Aggregate per player
    const aggregated: PlayerAggregated[] = [];

    players.forEach(p => {
      const pId = String(p.id);
      const pm = playerMatches.get(pId) || new Set<string>();
      const agg: PlayerAggregated = {
        player: { id: pId, firstName: p.firstName, lastName: p.lastName || '', position: p.position || 'N/A', xp: Number(p.xp || 0) },
        matches: pm.size, wins: 0, draws: 0, losses: 0,
        goals: 0, assists: 0, cleanSheets: 0, motmVotes: 0, defensiveImpactVotes: 0,
        sumImpact: 0, impactCount: 0,
        maxSingleGoals: 0, maxSingleAssists: 0, maxSingleMotmVotes: 0,
        wonGoals: 0, wonAssists: 0, wonCleanSheets: 0, wonDefensiveImpact: 0, wonMotmVotes: 0
      };

      pm.forEach(mId => {
        const m = matchMap.get(mId);
        if (!m) return;
        const team = playerMatchTeam.get(`${mId}_${pId}`);
        if (!team) return;
        const hG = m.homeTeamGoals, aG = m.awayTeamGoals;
        let result: 'W' | 'D' | 'L' = 'D';
        if (hG === aG) { agg.draws++; }
        else {
          const isHome = team === 'home';
          if ((isHome ? hG : aG) > (isHome ? aG : hG)) { result = 'W'; agg.wins++; }
          else { result = 'L'; agg.losses++; }
        }

        const ps = matchStatsMap.get(mId)?.get(pId);
        if (ps) {
          agg.goals += ps.goals; agg.assists += ps.assists; agg.cleanSheets += ps.cleanSheets;
          agg.sumImpact += ps.impact; agg.impactCount++;
          if (ps.goals > agg.maxSingleGoals) agg.maxSingleGoals = ps.goals;
          if (ps.assists > agg.maxSingleAssists) agg.maxSingleAssists = ps.assists;
          if (result === 'W') { agg.wonGoals += ps.goals; agg.wonAssists += ps.assists; agg.wonCleanSheets += ps.cleanSheets; }
        }

        const motm = motmVotesMap.get(mId)?.get(pId) || 0;
        agg.motmVotes += motm;
        if (motm > agg.maxSingleMotmVotes) agg.maxSingleMotmVotes = motm;
        if (result === 'W') agg.wonMotmVotes += motm;

        const isDI = (team === 'home' && m.homeDefensiveImpactId === pId) || (team === 'away' && m.awayDefensiveImpactId === pId);
        if (isDI) { agg.defensiveImpactVotes++; if (result === 'W') agg.wonDefensiveImpact++; }
      });

      aggregated.push(agg);
    });

    // Compute league averages (average of per-player-per-match averages across all players who played)
    const playersWithMatches = aggregated.filter(a => a.matches > 0);
    const totalPlayers = playersWithMatches.length;
    const leagueAvg = {
      goals: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.goals / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      assists: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.assists / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      cleanSheets: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.cleanSheets / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      motmVotes: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.motmVotes / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      defensiveImpactVotes: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.defensiveImpactVotes / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      impact: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + (a.impactCount > 0 ? a.sumImpact / a.impactCount : 0), 0) / totalPlayers).toFixed(2) : 0,
      winRate: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + (a.wins / a.matches) * 100, 0) / totalPlayers).toFixed(2) : 0,
      // xG/xA/xCS: goals/matches, assists/matches, cleanSheets/matches - same as per-match avg
      xG: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.goals / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      xA: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.assists / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      xCS: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.cleanSheets / a.matches, 0) / totalPlayers).toFixed(2) : 0,
      // Top Strengths league avg: avg of each player's max single match stats
      maxSingleGoals: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.maxSingleGoals, 0) / totalPlayers).toFixed(2) : 0,
      maxSingleAssists: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.maxSingleAssists, 0) / totalPlayers).toFixed(2) : 0,
      maxSingleMotmVotes: totalPlayers > 0 ? +(playersWithMatches.reduce((s, a) => s + a.maxSingleMotmVotes, 0) / totalPlayers).toFixed(2) : 0,
    };

    // ============== BUILD WORKBOOK ==============
    const wb = XLSX.utils.book_new();

    const name = (a: PlayerAggregated) => `${a.player.firstName} ${a.player.lastName}`.trim();
    const r2 = (n: number) => Number(n.toFixed(2));

    // ===== SHEET 1: INFLUENCE (Radar Chart Data) =====
    const influenceCalc = [
      [`INFLUENCE - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Section Description:'],
      ['Radar chart comparing player share (%) of league totals for 5 metrics: Goals, Assists, Clean Sheets, Defensive Impact, MOTM Votes'],
      [],
      ['Calculation Logic:'],
      ['Each metric value = (Player Total for Metric / League Total for Metric) * 100'],
      ['This gives the percentage share of league-wide totals that the player contributed.'],
      ['League Average line = each player has an equal share, so league avg = 100 / totalPlayers for each axis.'],
      [],
      ['Player Name', 'Goals Share (%)', 'Assists Share (%)', 'Clean Sheets Share (%)', 'Defensive Impact Share (%)', 'MOTM Votes Share (%)'],
    ];
    const leagueTotalGoals = aggregated.reduce((s, a) => s + a.goals, 0);
    const leagueTotalAssists = aggregated.reduce((s, a) => s + a.assists, 0);
    const leagueTotalCS = aggregated.reduce((s, a) => s + a.cleanSheets, 0);
    const leagueTotalDIV = aggregated.reduce((s, a) => s + a.defensiveImpactVotes, 0);
    const leagueTotalMotm = aggregated.reduce((s, a) => s + a.motmVotes, 0);

    aggregated.forEach(a => {
      influenceCalc.push([
        name(a) as any,
        leagueTotalGoals > 0 ? r2((a.goals / leagueTotalGoals) * 100) as any : 0,
        leagueTotalAssists > 0 ? r2((a.assists / leagueTotalAssists) * 100) as any : 0,
        leagueTotalCS > 0 ? r2((a.cleanSheets / leagueTotalCS) * 100) as any : 0,
        leagueTotalDIV > 0 ? r2((a.defensiveImpactVotes / leagueTotalDIV) * 100) as any : 0,
        leagueTotalMotm > 0 ? r2((a.motmVotes / leagueTotalMotm) * 100) as any : 0,
      ]);
    });
    influenceCalc.push([] as any);
    influenceCalc.push(['League Totals:', leagueTotalGoals, leagueTotalAssists, leagueTotalCS, leagueTotalDIV, leagueTotalMotm] as any);

    const wsInfluence = XLSX.utils.aoa_to_sheet(influenceCalc);
    XLSX.utils.book_append_sheet(wb, wsInfluence, 'INFLUENCE');

    // ===== SHEET 2: WIN LOSS DRAW =====
    const wldCalc = [
      [`WIN / LOSS / DRAW - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Section Description:'],
      ['Pie chart showing the percentage of Wins, Losses, and Draws for each player.'],
      [],
      ['Calculation Logic:'],
      ['Win % = (Player Wins / Player Total Matches) * 100'],
      ['Loss % = (Player Losses / Player Total Matches) * 100'],
      ['Draw % = (Player Draws / Player Total Matches) * 100'],
      ['A Win/Loss/Draw is determined by comparing team goals (home or away based on player lineup).'],
      [],
      ['Player Name', 'Matches', 'Wins', 'Losses', 'Draws', 'Win %', 'Loss %', 'Draw %'],
    ];
    aggregated.forEach(a => {
      const n = a.matches || 1;
      wldCalc.push([
        name(a) as any, a.matches as any,
        a.wins as any, a.losses as any, a.draws as any,
        r2((a.wins / n) * 100) as any,
        r2((a.losses / n) * 100) as any,
        r2((a.draws / n) * 100) as any,
      ]);
    });
    const wsWLD = XLSX.utils.aoa_to_sheet(wldCalc);
    XLSX.utils.book_append_sheet(wb, wsWLD, 'WIN LOSS DRAW');

    // ===== SHEET 3: IMPACT =====
    const impactCalc = [
      [`IMPACT - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Section Description:'],
      ['Two tables: (1) Expected metrics (xG, xA, xCS, Win Rate) and (2) Raw totals (Goals, Assists, Clean Sheets, MOTM Votes, Defensive Impact Votes, Game Contribution Index).'],
      [],
      ['--- TABLE 1: Expected Metrics ---'],
      ['Calculation Logic:'],
      ['Expected to score a goal (xG) = Player Total Goals / Player Total Matches'],
      ['Expected to assist a goal (xA) = Player Total Assists / Player Total Matches'],
      ['Expected to keep Clean Sheet (xCS) = Player Total Clean Sheets / Player Total Matches'],
      ['Win Rate = (Player Wins / Player Total Matches) * 100'],
      [],
      ['League Average Calculation:'],
      ['For each metric, we compute each player\'s per-match average, then average those across all players.'],
      [`League Avg xG = ${leagueAvg.xG}, League Avg xA = ${leagueAvg.xA}, League Avg xCS = ${leagueAvg.xCS}, League Avg Win Rate = ${leagueAvg.winRate}%`],
      [],
      ['Player Name', 'Matches', 'xG (Your Stats)', 'xG (League Avg)', 'xA (Your Stats)', 'xA (League Avg)', 'xCS (Your Stats)', 'xCS (League Avg)', 'Win Rate (Your Stats)', 'Win Rate (League Avg)'],
    ];
    aggregated.forEach(a => {
      const n = a.matches || 1;
      impactCalc.push([
        name(a) as any, a.matches as any,
        r2(a.goals / n) as any, leagueAvg.xG as any,
        r2(a.assists / n) as any, leagueAvg.xA as any,
        r2(a.cleanSheets / n) as any, leagueAvg.xCS as any,
        `${Math.round((a.wins / n) * 100)}%` as any, `${leagueAvg.winRate}%` as any,
      ]);
    });

    impactCalc.push([] as any);
    impactCalc.push(['--- TABLE 2: Raw Stats Totals ---'] as any);
    impactCalc.push(['Calculation Logic:'] as any);
    impactCalc.push(['Goals = Sum of goals across all matches for the player'] as any);
    impactCalc.push(['Assists = Sum of assists across all matches for the player'] as any);
    impactCalc.push(['Clean Sheets = Sum of clean_sheets across all matches for the player'] as any);
    impactCalc.push(['MOTM Votes = Count of votes received across all matches for the player'] as any);
    impactCalc.push(['Defensive Impact Votes = Count of matches where player was voted homeDefensiveImpactId or awayDefensiveImpactId'] as any);
    impactCalc.push(['Game Contribution Index = Average of "impact" field (0-100) entered by admins per match'] as any);
    impactCalc.push([`League Avg: Goals=${leagueAvg.goals}, Assists=${leagueAvg.assists}, CS=${leagueAvg.cleanSheets}, MOTM=${leagueAvg.motmVotes}, DIV=${leagueAvg.defensiveImpactVotes}, GCI=${leagueAvg.impact}%`] as any);
    impactCalc.push([] as any);
    impactCalc.push(['Player Name', 'Goals', 'Goals (League Avg)', 'Assists', 'Assists (League Avg)', 'Clean Sheets', 'CS (League Avg)', 'MOTM Votes', 'MOTM (League Avg)', 'Def Impact Votes', 'DIV (League Avg)', 'Game Contribution Index (%)', 'GCI (League Avg %)'] as any);

    aggregated.forEach(a => {
      const gci = a.impactCount > 0 ? Math.round(a.sumImpact / a.impactCount) : 0;
      impactCalc.push([
        name(a) as any,
        a.goals as any, leagueAvg.goals as any,
        a.assists as any, leagueAvg.assists as any,
        a.cleanSheets as any, leagueAvg.cleanSheets as any,
        a.motmVotes as any, leagueAvg.motmVotes as any,
        a.defensiveImpactVotes as any, leagueAvg.defensiveImpactVotes as any,
        `${gci}%` as any, `${leagueAvg.impact}%` as any,
      ]);
    });

    const wsImpact = XLSX.utils.aoa_to_sheet(impactCalc);
    XLSX.utils.book_append_sheet(wb, wsImpact, 'IMPACT');

    // ===== SHEET 4: YOUR TOP STRENGTHS =====
    const strengthsCalc = [
      [`YOUR TOP STRENGTHS - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Section Description:'],
      ['Shows the player\'s MAXIMUM stats achieved in a SINGLE match (best game) for Assists, Goals, and MOTM Votes.'],
      ['Compared against the league average of all players\' max single-match stats.'],
      [],
      ['Calculation Logic:'],
      ['For each player, find the highest Goals/Assists/MOTM in any single match.'],
      ['League Average = Sum of all players\' max single-match stat / Total Players who played'],
      [`League Avg Max Single Goals = ${leagueAvg.maxSingleGoals}`],
      [`League Avg Max Single Assists = ${leagueAvg.maxSingleAssists}`],
      [`League Avg Max Single MOTM Votes = ${leagueAvg.maxSingleMotmVotes}`],
      [],
      ['Rows are sorted by highest value descending per player. Only non-zero stats are shown on the UI.'],
      [],
      ['Player Name', 'Max Goals (Single Match)', 'Max Goals (League Avg)', 'Max Assists (Single Match)', 'Max Assists (League Avg)', 'Max MOTM Votes (Single Match)', 'Max MOTM (League Avg)'],
    ];
    aggregated.forEach(a => {
      strengthsCalc.push([
        name(a) as any,
        a.maxSingleGoals as any, leagueAvg.maxSingleGoals as any,
        a.maxSingleAssists as any, leagueAvg.maxSingleAssists as any,
        a.maxSingleMotmVotes as any, leagueAvg.maxSingleMotmVotes as any,
      ]);
    });
    strengthsCalc.push([] as any);
    strengthsCalc.push(['UI Display Note: "Assists: 2; league average 0." text is generated from the top-ranked strength row.'] as any);

    const wsStrengths = XLSX.utils.aoa_to_sheet(strengthsCalc);
    XLSX.utils.book_append_sheet(wb, wsStrengths, 'YOUR TOP STRENGTHS');

    // ===== SHEET 5: FOCUS AREA =====
    const focusCalc = [
      [`FOCUS AREA - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Player Name', 'Focus Message'],
    ];

    const focusMessages: Record<string, string> = {
      'Goals': "Focus on building your goal-scoring consistency, and you'll continue to rise among the league’s top scorers. Keep pushing yourself, and the goals will follow.",
      'Assists': "By increasing your assists, you'll elevate your game even further. Keep playing with vision and creativity, and you'll make a greater impact on match results",
      'Clean Sheets': "Each game provides an opportunity to sharpen your defensive and goalkeeping skills. By focusing on these areas, you can help transform losses into wins.",
      'MOTM Votes': "To stand out even more, focus on delivering consistent performances in every match – keep it simple, effective, and stay confident in your approach.",
      'Captains Performance': "To enhance your leadership even further, continue delivering outstanding performances. Leading by example will inspire everyone to perform at their highest level.",
      'Total Wins': "Keep enhancing your performances, and you'll start turning every opportunity into more victories for both yourself and your team",
      '% Win Influence Rate': "To make an even greater impact on matches, maintain your focus throughout, keep your game simple, effective, and trust your instincts"
    };

    aggregated.forEach(a => {
      if (a.matches === 0) {
        focusCalc.push([name(a) as any, 'Play matches to unlock a personalized focus area.' as any]);
        return;
      }
      const n = a.matches;
      const gci = a.impactCount > 0 ? Math.round(a.sumImpact / a.impactCount) : 0;

      const metrics = [
        { metric: 'Goals', yours: a.goals, avg: Number(leagueAvg.goals) },
        { metric: 'Assists', yours: a.assists, avg: Number(leagueAvg.assists) },
        { metric: 'Clean Sheets', yours: a.cleanSheets, avg: Number(leagueAvg.cleanSheets) },
        { metric: 'MOTM Votes', yours: a.motmVotes, avg: Number(leagueAvg.motmVotes) },
        { metric: 'Captains Performance', yours: a.wonDefensiveImpact, avg: 0 }, // fallback or custom metric mapping
        { metric: 'Total Wins', yours: a.wins, avg: 0 },
        { metric: '% Win Influence Rate', yours: Math.round((a.wins / n) * 100), avg: Number(leagueAvg.winRate) },
      ];

      let biggest: { metric: string; yours: number; avg: number; gap: number; gapRatio: number } | null = null;
      metrics.forEach(m => {
        const gap = m.avg - m.yours;
        if (gap <= 0) return;
        const isPct = m.metric.includes('%') || m.metric === 'Captains Performance';
        const gapRatio = isPct ? gap / 100 : gap / Math.max(Math.abs(m.avg), 1);
        if (!biggest || gapRatio > biggest.gapRatio) {
          biggest = { ...m, gap, gapRatio };
        }
      });

      if (biggest) {
        const b = biggest as any;
        focusCalc.push([
          name(a) as any,
          (focusMessages[b.metric] || 'Work on this area to improve.') as any
        ]);
      } else {
        focusCalc.push([name(a) as any,
          'All your metrics are currently above the league average. Keep up the excellent work and continue building your consistency to maintain this edge!' as any]);
      }
    });

    const wsFocus = XLSX.utils.aoa_to_sheet(focusCalc);
    XLSX.utils.book_append_sheet(wb, wsFocus, 'FOCUS AREA');

    // ===== SHEET 6: WIN INFLUENCE CALC =====
    const winInflCalc = [
      [`% WIN INFLUENCE - ${TARGET_LEAGUE_NAME}`],
      [],
      ['Section Description:'],
      ['Measures how much a player contributed to their team\'s WINS compared to the entire league.'],
      [],
      ['Calculation Logic:'],
      ['Only stats from matches the player\'s team WON are used.'],
      ['Formula: Win Influence = Sum( (Player Won Metric / League Won Metric Total) * Weight )'],
      [],
      ['Metric', 'Weight'],
      ['Goals in Wins', '30% (0.3)'],
      ['Assists in Wins', '20% (0.2)'],
      ['Clean Sheets in Wins', '20% (0.2)'],
      ['Defensive Impact in Wins', '10% (0.1)'],
      ['MOTM Votes in Wins', '20% (0.2)'],
      [],
      [`League Win Totals: Goals=${leagueWinTotals.goals}, Assists=${leagueWinTotals.assists}, CS=${leagueWinTotals.cleanSheets}, DI=${leagueWinTotals.defensiveImpact}, MOTM=${leagueWinTotals.motmVotes}`],
      [],
      ['Player Name', 'Won Goals', 'Goals Share', 'Won Assists', 'Assists Share', 'Won CS', 'CS Share', 'Won DI', 'DI Share', 'Won MOTM', 'MOTM Share', 'Win Influence (%)'],
    ];
    aggregated.forEach(a => {
      const gS = leagueWinTotals.goals > 0 ? r2(a.wonGoals / leagueWinTotals.goals) : 0;
      const aS = leagueWinTotals.assists > 0 ? r2(a.wonAssists / leagueWinTotals.assists) : 0;
      const cS = leagueWinTotals.cleanSheets > 0 ? r2(a.wonCleanSheets / leagueWinTotals.cleanSheets) : 0;
      const dS = leagueWinTotals.defensiveImpact > 0 ? r2(a.wonDefensiveImpact / leagueWinTotals.defensiveImpact) : 0;
      const mS = leagueWinTotals.motmVotes > 0 ? r2(a.wonMotmVotes / leagueWinTotals.motmVotes) : 0;
      const winInf = r2((gS * 0.3 + aS * 0.2 + cS * 0.2 + dS * 0.1 + mS * 0.2) * 100);

      winInflCalc.push([
        name(a) as any,
        a.wonGoals as any, gS as any,
        a.wonAssists as any, aS as any,
        a.wonCleanSheets as any, cS as any,
        a.wonDefensiveImpact as any, dS as any,
        a.wonMotmVotes as any, mS as any,
        `${winInf}%` as any,
      ]);
    });

    const wsWinInf = XLSX.utils.aoa_to_sheet(winInflCalc);
    XLSX.utils.book_append_sheet(wb, wsWinInf, 'WIN INFLUENCE');

    // Auto-fit all sheets
    const autofit = (ws: any) => {
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
      const cols = [];
      for (let C = range.s.c; C <= range.e.c; ++C) {
        let maxLen = 0;
        for (let R = range.s.r; R <= range.e.r; ++R) {
          const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
          if (cell && cell.v !== undefined) { const len = String(cell.v).length; if (len > maxLen) maxLen = len; }
        }
        cols.push({ wch: Math.min(maxLen + 4, 60) });
      }
      ws['!cols'] = cols;
    };
    [wsInfluence, wsWLD, wsImpact, wsStrengths, wsFocus, wsWinInf].forEach(autofit);

    // Write file
    const paths = [
      'C:\\Users\\tech solutionor\\Downloads\\CF_Season7_FNF_Dashboard.xlsx',
      `C:\\Users\\tech solutionor\\Downloads\\CF_Season7_FNF_Dashboard_${Date.now()}.xlsx`
    ];
    for (const p of paths) {
      try { XLSX.writeFile(wb, p); console.log(`Excel created at: ${p}`); break; }
      catch { console.log(`Could not write to ${p}. Trying next.`); }
    }

  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

run();

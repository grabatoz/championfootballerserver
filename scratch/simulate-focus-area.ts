import dotenv from 'dotenv';
import path from 'path';
import { Sequelize, QueryTypes } from 'sequelize';

dotenv.config({ path: path.join(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL || '';

// Mock formatting helper matching frontend
const formatStatDecimal = (value: number, suffix = ''): string => {
  const rounded = Math.round(value * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${display}${suffix}`;
};

async function main() {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
  });

  await sequelize.authenticate();
  console.log('✅ Connected to database\n');

  // Discover tables
  const tables = await sequelize.query<any>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    { type: QueryTypes.SELECT }
  );
  const tableNames = tables.map((t: any) => t.tablename);
  const leagueTable = tableNames.find((t: string) => t.toLowerCase() === 'leagues') || 'Leagues';
  const matchTable = tableNames.find((t: string) => t.toLowerCase() === 'matches') || 'Matches';
  const statsTable = tableNames.find((t: string) => t.toLowerCase() === 'match_statistics') || 'match_statistics';
  const usersTable = tableNames.find((t: string) => t.toLowerCase() === 'users') || 'users';
  const votesTable = tableNames.find((t: string) => t.toLowerCase() === 'votes') || 'Votes';

  // Get all leagues
  const leagues = await sequelize.query<any>(
    `SELECT id, name FROM "${leagueTable}"`,
    { type: QueryTypes.SELECT }
  );

  for (const league of leagues) {
    // 1. Get completed matches in league
    const matches = await sequelize.query<any>(
      `SELECT id, "homeDefensiveImpactId", "awayDefensiveImpactId"
       FROM "${matchTable}"
       WHERE "leagueId" = $1
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
         AND deleted = false`,
      { bind: [league.id], type: QueryTypes.SELECT }
    );
    const matchIds = matches.map((m: any) => m.id);
    if (matchIds.length === 0) continue;

    // 2. Get stats and votes
    const stats = await sequelize.query<any>(
      `SELECT ms.user_id, ms.goals, ms.assists, ms.clean_sheets AS "cleanSheets", ms.defence, ms.impact, ms.match_id
       FROM "${statsTable}" ms
       JOIN "${usersTable}" u ON u.id = ms.user_id
       WHERE ms.match_id = ANY($1)
         AND u.email IS NOT NULL AND u.email != ''`,
      { bind: [matchIds], type: QueryTypes.SELECT }
    );

    const votes = await sequelize.query<any>(
      `SELECT v."votedForId"
       FROM "${votesTable}" v
       WHERE v."matchId" = ANY($1)`,
      { bind: [matchIds], type: QueryTypes.SELECT }
    );

    const defImpacts = matches;

    // 3. Build playerMap
    const playerMap: Record<string, { id: string; name: string; goals: number; assists: number; cleanSheets: number; defence: number; impact: number; motmVotes: number; defensiveImpactVotes: number; matches: number }> = {};
    
    // Get player names
    const uniquePlayerIds = [...new Set(stats.map((s: any) => String(s.user_id)))];
    if (uniquePlayerIds.length === 0) continue;

    const nameResults = await sequelize.query<any>(
      `SELECT id, "firstName", "lastName" FROM "${usersTable}" WHERE id = ANY($1)`,
      { bind: [uniquePlayerIds], type: QueryTypes.SELECT }
    );
    const playerNames: Record<string, string> = {};
    for (const nr of nameResults) {
      playerNames[String(nr.id)] = `${nr.firstName || ''} ${nr.lastName || ''}`.trim() || nr.id;
    }

    const ensurePlayer = (uid: string) => {
      if (!playerMap[uid]) {
        playerMap[uid] = { id: uid, name: playerNames[uid] || uid, goals: 0, assists: 0, cleanSheets: 0, defence: 0, impact: 0, motmVotes: 0, defensiveImpactVotes: 0, matches: 0 };
      }
      return playerMap[uid];
    };

    for (const stat of stats) {
      const uid = String(stat.user_id);
      const p = ensurePlayer(uid);
      p.goals += Number(stat.goals) || 0;
      p.assists += Number(stat.assists) || 0;
      p.cleanSheets += Number(stat.cleanSheets) || 0;
      p.defence += Number(stat.defence) || 0;
      p.impact += Number(stat.impact) || 0;
      p.matches += 1;
    }

    for (const vote of votes) {
      const uid = String(vote.votedForId);
      if (playerMap[uid]) {
        playerMap[uid].motmVotes += 1;
      }
    }

    for (const m of defImpacts) {
      if (m.homeDefensiveImpactId && playerMap[String(m.homeDefensiveImpactId)]) {
        playerMap[String(m.homeDefensiveImpactId)].defensiveImpactVotes += 1;
      }
      if (m.awayDefensiveImpactId && playerMap[String(m.awayDefensiveImpactId)]) {
        playerMap[String(m.awayDefensiveImpactId)].defensiveImpactVotes += 1;
      }
    }

    const playerIds = Object.keys(playerMap);
    const totalPlayers = playerIds.length;

    // 4. Calculate per-match averages per player, then average those across players
    const metricKeys = ['goals', 'assists', 'cleanSheets', 'defence', 'motmVotes', 'defensiveImpactVotes', 'impact'] as const;
    const leagueAveragePerMatch: Record<string, number> = {};
    for (const key of metricKeys) {
      const playerAvgs = playerIds.map(uid => {
        const p = playerMap[uid];
        const mc = Math.max(p.matches, 1);
        return p[key] / mc;
      });
      const sumAvg = playerAvgs.reduce((a, b) => a + b, 0);
      leagueAveragePerMatch[key] = totalPlayers > 0 ? +(sumAvg / totalPlayers).toFixed(4) : 0;
    }

    // 5. Simulate Focus Area for each player
    console.log(`\n============================================================`);
    console.log(`LEAGUE: ${league.name} (${league.id})`);
    console.log(`============================================================`);

    for (const uid of playerIds) {
      const yourStats = playerMap[uid];
      const matchCount = yourStats.matches;
      if (matchCount === 0) continue;

      // Calculate Game Contribution Index average (already percentage)
      const yourImpactAvg = yourStats.impact / matchCount;

      // Define comparison rows matching frontend scaling fix
      const rows = [
        {
          metric: 'Goals',
          yourTotal: yourStats.goals / matchCount,
          yourDisplay: formatStatDecimal(yourStats.goals / matchCount),
          leagueAverage: leagueAveragePerMatch.goals,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.goals),
        },
        {
          metric: 'Assists',
          yourTotal: yourStats.assists / matchCount,
          yourDisplay: formatStatDecimal(yourStats.assists / matchCount),
          leagueAverage: leagueAveragePerMatch.assists,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.assists),
        },
        {
          metric: 'Clean Sheets',
          yourTotal: yourStats.cleanSheets / matchCount,
          yourDisplay: formatStatDecimal(yourStats.cleanSheets / matchCount),
          leagueAverage: leagueAveragePerMatch.cleanSheets,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.cleanSheets),
        },
        {
          metric: 'MOTM Votes',
          yourTotal: yourStats.motmVotes / matchCount,
          yourDisplay: formatStatDecimal(yourStats.motmVotes / matchCount),
          leagueAverage: leagueAveragePerMatch.motmVotes,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.motmVotes),
        },
        {
          metric: 'Defensive Impact Votes',
          yourTotal: yourStats.defensiveImpactVotes / matchCount,
          yourDisplay: formatStatDecimal(yourStats.defensiveImpactVotes / matchCount),
          leagueAverage: leagueAveragePerMatch.defensiveImpactVotes,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.defensiveImpactVotes),
        },
        {
          metric: 'Game Contribution Index',
          yourTotal: yourImpactAvg,
          yourDisplay: `${Math.round(yourImpactAvg)}%`,
          leagueAverage: leagueAveragePerMatch.impact,
          leagueDisplay: formatStatDecimal(leagueAveragePerMatch.impact, '%'),
        },
      ];

      // Focus Area Suggestion Algorithm (matching career/page.tsx)
      const focusCopy: Record<string, { action: string; metricName: string; verb: 'is' | 'are' }> = {
        Goals: { action: 'finishing', metricName: 'goals', verb: 'are' },
        Assists: { action: 'key passes', metricName: 'assists', verb: 'are' },
        'Clean Sheets': { action: 'defensive positioning', metricName: 'clean sheets', verb: 'are' },
        'MOTM Votes': { action: 'match-defining moments', metricName: 'MOTM votes', verb: 'are' },
        'Defensive Impact Votes': { action: 'defensive impact', metricName: 'defensive impact votes', verb: 'are' },
        'Game Contribution Index': { action: 'overall influence', metricName: 'game contribution index', verb: 'is' },
      };

      const comparableRows = rows
        .filter((row) => focusCopy[row.metric])
        .filter((row) => row.metric !== 'Clean Sheets' || yourStats.cleanSheets > 0)
        .filter((row) => row.yourTotal > 0 || row.leagueAverage > 0);

      let focusSuggestion = '';
      if (!comparableRows.length) {
        focusSuggestion = 'Your available stats are still building; play more matches to unlock a clearer focus area.';
      } else {
        const rowsWithGap = comparableRows.map((row) => {
          const gap = row.leagueAverage - row.yourTotal;
          const gapRatio = gap / Math.max(Math.abs(row.leagueAverage), 1);
          return { row, gap, gapRatio };
        });

        const target = rowsWithGap
          .filter((item) => item.gap > 0 && item.row.leagueDisplay !== item.row.yourDisplay)
          .sort((a, b) => b.gapRatio - a.gapRatio || b.gap - a.gap)[0];

        if (target) {
          const copy = focusCopy[target.row.metric];
          focusSuggestion = `Focus on ${copy.action}: your ${copy.metricName} ${copy.verb} ${target.row.yourDisplay}; league average ${target.row.leagueDisplay}.`;
        } else {
          const strongest = rowsWithGap
            .sort((a, b) => (b.row.yourTotal - b.row.leagueAverage) - (a.row.yourTotal - a.row.leagueAverage))[0];
          const copy = focusCopy[strongest.row.metric];
          focusSuggestion = `Your ${copy.metricName} ${copy.verb} already above league average; keep building ${copy.action} to maintain that edge.`;
        }
      }

      console.log(`  Player: ${yourStats.name.padEnd(20)} (Matches: ${matchCount}) -> ${focusSuggestion}`);
    }
  }

  await sequelize.close();
}

main().catch(console.error);

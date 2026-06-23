const { Sequelize, QueryTypes } = require('sequelize');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  logging: false
});

async function main() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database');

    const leagueId = 'bd7ce507-e8ea-4af2-a2f2-b48374e1f7fe'; // Season 6 FNF

    // 2. Find all matches in this league that are completed
    const completedMatches = await sequelize.query(
      `SELECT id, date, "homeDefensiveImpactId", "awayDefensiveImpactId" 
       FROM "Matches" 
       WHERE "leagueId" = :leagueId AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')`,
      { replacements: { leagueId }, type: QueryTypes.SELECT }
    );
    console.log(`Found ${completedMatches.length} completed matches`);

    if (completedMatches.length === 0) {
      console.log('No completed matches found. Exiting.');
      await sequelize.close();
      return;
    }

    const matchIds = completedMatches.map(m => m.id);

    // 3. Find all player stats for these matches (excluding guests)
    const stats = await sequelize.query(
      `SELECT ms.user_id, ms.goals, ms.assists, ms.clean_sheets as "cleanSheets", ms.defence, ms.impact,
              u."firstName", u."lastName", u.email, u.provider
       FROM "match_statistics" ms
       JOIN "users" u ON ms.user_id = u.id
       WHERE ms.match_id IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT }
    );

    // Filter out guest users
    const nonGuestStats = stats.filter(s => {
      const emailLower = (s.email || '').toLowerCase();
      const isGuest = s.provider === 'guest' || 
                      !s.email || 
                      emailLower.includes('guest') || 
                      emailLower.includes('@local.invalid') || 
                      s.firstName?.toLowerCase().includes('guest') || 
                      s.lastName?.toLowerCase().includes('guest');
      return !isGuest;
    });

    // 4. Find all MOTM votes for these matches
    const votes = await sequelize.query(
      `SELECT "votedForId" FROM "Votes" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT }
    );

    // Count MOTM votes per user
    const motmMap = {};
    votes.forEach(v => {
      const uid = v.votedForId;
      if (uid) {
        motmMap[uid] = (motmMap[uid] || 0) + 1;
      }
    });

    // Count defensive impact votes per user
    const defImpactMap = {};
    completedMatches.forEach(m => {
      if (m.homeDefensiveImpactId) {
        defImpactMap[m.homeDefensiveImpactId] = (defImpactMap[m.homeDefensiveImpactId] || 0) + 1;
      }
      if (m.awayDefensiveImpactId) {
        defImpactMap[m.awayDefensiveImpactId] = (defImpactMap[m.awayDefensiveImpactId] || 0) + 1;
      }
    });

    // 5. Aggregate stats per player
    const playerMap = {};
    nonGuestStats.forEach(s => {
      const uid = s.user_id;
      if (!playerMap[uid]) {
        playerMap[uid] = {
          name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          defence: 0,
          impact: 0,
          matches: 0,
          matchesWithGoals: 0,
          matchesWithAssists: 0,
          matchesWithCleanSheets: 0,
        };
      }
      const p = playerMap[uid];
      const g = Number(s.goals) || 0;
      const a = Number(s.assists) || 0;
      const cs = Number(s.cleanSheets) || 0;

      p.goals += g;
      p.assists += a;
      p.cleanSheets += cs;
      p.defence += Number(s.defence) || 0;
      p.impact += Number(s.impact) || 0;
      p.matches += 1;

      if (g > 0) p.matchesWithGoals += 1;
      if (a > 0) p.matchesWithAssists += 1;
      if (cs > 0) p.matchesWithCleanSheets += 1;
    });

    // Combine maps and compute averages
    const playerList = Object.keys(playerMap).map(uid => {
      const p = playerMap[uid];
      p.motmVotes = motmMap[uid] || 0;
      p.defensiveImpactVotes = defImpactMap[uid] || 0;
      
      // Calculate averages/rates
      const mc = p.matches;
      p.goalsPerMatch = mc > 0 ? (p.goals / mc).toFixed(2) : '0.00';
      p.assistsPerMatch = mc > 0 ? (p.assists / mc).toFixed(2) : '0.00';
      p.cleanSheetsPerMatch = mc > 0 ? (p.cleanSheets / mc).toFixed(2) : '0.00';
      p.avgImpact = mc > 0 ? (p.impact / mc).toFixed(1) : '0.0';
      
      // Expected (match probabilities)
      p.xG = mc > 0 ? (p.matchesWithGoals / mc).toFixed(2) : '0.00';
      p.xA = mc > 0 ? (p.matchesWithAssists / mc).toFixed(2) : '0.00';
      p.xCS = mc > 0 ? (p.matchesWithCleanSheets / mc).toFixed(2) : '0.00';

      return p;
    });

    // Sort by matches / goals descending
    playerList.sort((a, b) => b.matches - a.matches || b.goals - a.goals);

    // Calculate League Totals & Averages
    const totalPlayers = playerList.length;
    const leagueTotals = playerList.reduce((acc, p) => {
      acc.goals += p.goals;
      acc.assists += p.assists;
      acc.cleanSheets += p.cleanSheets;
      acc.defence += p.defence;
      acc.motmVotes += p.motmVotes;
      acc.defensiveImpactVotes += p.defensiveImpactVotes;
      acc.impact += p.impact;
      acc.matches += p.matches;
      return acc;
    }, { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0, defensiveImpactVotes: 0, impact: 0, matches: 0 });

    const leagueAverages = {
      totalPlayers,
      totalMatches: leagueTotals.matches,
      // Total Average (Total stats divided by players)
      avgGoalsPerPlayer: (leagueTotals.goals / totalPlayers).toFixed(1),
      avgAssistsPerPlayer: (leagueTotals.assists / totalPlayers).toFixed(1),
      avgCleanSheetsPerPlayer: (leagueTotals.cleanSheets / totalPlayers).toFixed(1),
      avgMotmPerPlayer: (leagueTotals.motmVotes / totalPlayers).toFixed(1),
      avgDefImpactPerPlayer: (leagueTotals.defensiveImpactVotes / totalPlayers).toFixed(1),

      // Expected/Rate Average (Total stats divided by total matches)
      expectedGoalsRate: (leagueTotals.goals / leagueTotals.matches).toFixed(2),
      expectedAssistsRate: (leagueTotals.assists / leagueTotals.matches).toFixed(2),
      expectedCleanSheetsRate: (leagueTotals.cleanSheets / leagueTotals.matches).toFixed(2),
      avgImpactRate: (leagueTotals.impact / leagueTotals.matches).toFixed(1),
    };

    console.log('\n--- League Totals ---');
    console.log(leagueTotals);

    console.log('\n--- League Averages & Expected Rates ---');
    console.log(leagueAverages);

  } catch (err) {
    console.error('Database error:', err);
  } finally {
    await sequelize.close();
  }
}

main();

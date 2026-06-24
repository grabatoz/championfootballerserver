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
    console.log('✅ DB Connected!');

    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF

    // 1. Get completed match IDs
    const matches = await sequelize.query(
      `SELECT id FROM "Matches"
       WHERE "leagueId" = :leagueId
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
         AND deleted = false`,
      { replacements: { leagueId }, type: QueryTypes.SELECT }
    );
    const matchIds = matches.map((m) => m.id);
    console.log(`Matches count: ${matchIds.length}`);

    if (matchIds.length === 0) {
      console.log('No matches found.');
      return;
    }

    // 2. Query player statistics (excluding guests)
    const allStats = await sequelize.query(
      `SELECT ms.user_id, ms.goals, ms.assists, ms.clean_sheets AS "cleanSheets", ms.defence, ms.match_id
       FROM match_statistics ms
       JOIN users u ON u.id = ms.user_id
         WHERE ms.match_id IN (:matchIds)
           AND u.email IS NOT NULL
           AND u.email != ''
           AND u.email NOT ILIKE '%guest%'
           AND u."firstName" NOT ILIKE '%guest%'`,
      { replacements: { matchIds }, type: QueryTypes.SELECT }
    );

    // 3. Get MOTM votes
    const motmVotes = await sequelize.query(
      `SELECT v."votedForId"
       FROM "Votes" v
       WHERE v."matchId" IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT }
    );

    // 3.5 Get Defensive Impact votes
    const defensiveImpactPicks = await sequelize.query(
      `SELECT "homeDefensiveImpactId", "awayDefensiveImpactId"
       FROM "Matches"
       WHERE id IN (:matchIds)`,
      { replacements: { matchIds }, type: QueryTypes.SELECT }
    );

    // 4. Player names lookup
    const uniquePlayerIds = [...new Set(allStats.map((s) => String(s.user_id)))];
    const playerNames = {};
    if (uniquePlayerIds.length > 0) {
      const nameResults = await sequelize.query(
        `SELECT id, "firstName", "lastName" FROM users WHERE id IN (:uniquePlayerIds)`,
        { replacements: { uniquePlayerIds }, type: QueryTypes.SELECT }
      );
      for (const nr of nameResults) {
        playerNames[String(nr.id)] = `${nr.firstName || ''} ${nr.lastName || ''}`.trim();
      }
    }

    // 5. Aggregate data per player
    const playerMap = {};
    const ensurePlayer = (uid) => {
      if (!playerMap[uid]) {
        playerMap[uid] = { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0 };
      }
      return playerMap[uid];
    };

    for (const stat of allStats) {
      const uid = String(stat.user_id);
      const p = ensurePlayer(uid);
      p.goals += Number(stat.goals) || 0;
      p.assists += Number(stat.assists) || 0;
      p.cleanSheets += Number(stat.cleanSheets) || 0;
      // Note: we don't use ms.defence since Defensive Impact votes are stored at Match level.
    }

    for (const vote of motmVotes) {
      const uid = String(vote.votedForId);
      if (playerMap[uid]) {
        playerMap[uid].motmVotes += 1;
      }
    }

    for (const pick of defensiveImpactPicks) {
      if (pick.homeDefensiveImpactId) {
        const uid = String(pick.homeDefensiveImpactId);
        if (playerMap[uid]) {
          playerMap[uid].defence += 1;
        }
      }
      if (pick.awayDefensiveImpactId) {
        const uid = String(pick.awayDefensiveImpactId);
        if (playerMap[uid]) {
          playerMap[uid].defence += 1;
        }
      }
    }

    const playerIds = Object.keys(playerMap);
    const totalPlayers = playerIds.length;
    console.log(`Total Players: ${totalPlayers}`);

    // Print raw player data table
    console.log('\n### Player Influence Totals');
    console.log('| Player Name | Goals | Assists | Clean Sheets | Defensive Impact | MOTM Votes |');
    console.log('| :--- | :---: | :---: | :---: | :---: | :---: |');
    for (const uid of playerIds) {
      const p = playerMap[uid];
      const name = playerNames[uid] || uid;
      console.log(`| ${name} | ${p.goals} | ${p.assists} | ${p.cleanSheets} | ${p.defence} | ${p.motmVotes} |`);
    }

    // Print league totals & averages
    const leagueTotals = playerIds.reduce((acc, uid) => {
      const p = playerMap[uid];
      acc.goals += p.goals;
      acc.assists += p.assists;
      acc.cleanSheets += p.cleanSheets;
      acc.defence += p.defence;
      acc.motmVotes += p.motmVotes;
      return acc;
    }, { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0 });

    console.log('\n### League Totals and Averages (Total Players = ' + totalPlayers + ')');
    console.log('| Metric | Total | Divisor (Total Players) | Calculated Average |');
    console.log('| :--- | :---: | :---: | :---: |');
    console.log(`| Goals | ${leagueTotals.goals} | ${totalPlayers} | ${(leagueTotals.goals / totalPlayers).toFixed(2)} |`);
    console.log(`| Assists | ${leagueTotals.assists} | ${totalPlayers} | ${(leagueTotals.assists / totalPlayers).toFixed(2)} |`);
    console.log(`| Clean Sheets | ${leagueTotals.cleanSheets} | ${totalPlayers} | ${(leagueTotals.cleanSheets / totalPlayers).toFixed(2)} |`);
    console.log(`| Defensive Impact | ${leagueTotals.defence} | ${totalPlayers} | ${(leagueTotals.defence / totalPlayers).toFixed(2)} |`);
    console.log(`| MOTM Votes | ${leagueTotals.motmVotes} | ${totalPlayers} | ${(leagueTotals.motmVotes / totalPlayers).toFixed(2)} |`);

  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();

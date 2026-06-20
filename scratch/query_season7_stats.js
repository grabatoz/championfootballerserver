const { Sequelize } = require('sequelize');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres';
const sequelize = new Sequelize(databaseUrl, { logging: false });

async function main() {
  try {
    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF

    // Verify league exists
    const [[league]] = await sequelize.query(`SELECT name FROM "Leagues" WHERE id = :leagueId`, {
      replacements: { leagueId }
    });
    
    if (!league) {
      console.log('League not found!');
      return;
    }

    // Fetch player statistics using Team Sheets count (UserHomeMatches + UserAwayMatches)
    const [rows] = await sequelize.query(`
      SELECT 
        u.id as user_id,
        u."firstName",
        u."lastName",
        (
          SELECT COUNT(DISTINCT m.id)
          FROM "Matches" m
          LEFT JOIN "UserHomeMatches" uhm ON m.id = uhm."matchId" AND uhm."userId" = u.id
          LEFT JOIN "UserAwayMatches" uam ON m.id = uam."matchId" AND uam."userId" = u.id
          WHERE m."leagueId" = :leagueId AND (uhm."userId" IS NOT NULL OR uam."userId" IS NOT NULL)
        ) as matches_played,
        COALESCE(
          (
            SELECT SUM(ms.goals)
            FROM match_statistics ms
            JOIN "Matches" m ON ms.match_id = m.id
            WHERE ms.user_id = u.id AND m."leagueId" = :leagueId
          ), 0
        ) as total_goals,
        COALESCE(
          (
            SELECT SUM(ms.assists)
            FROM match_statistics ms
            JOIN "Matches" m ON ms.match_id = m.id
            WHERE ms.user_id = u.id AND m."leagueId" = :leagueId
          ), 0
        ) as total_assists,
        COALESCE(
          (
            SELECT SUM(ms.clean_sheets)
            FROM match_statistics ms
            JOIN "Matches" m ON ms.match_id = m.id
            WHERE ms.user_id = u.id AND m."leagueId" = :leagueId
          ), 0
        ) as total_clean_sheets
      FROM users u
      JOIN "LeagueMember" lm ON u.id = lm."userId"
      WHERE lm."leagueId" = :leagueId
      ORDER BY matches_played DESC, total_goals DESC
    `, {
      replacements: { leagueId }
    });

    if (rows.length === 0) {
      console.log('No players found in this league.');
      return;
    }

    console.log('| Player Name | Matches | Goals | Assists | Clean Sheets | xG (Matches/Goal) | xA (Matches/Assist) | xCS (Matches/CS) |');
    console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
    
    rows.forEach(r => {
      const matches = parseInt(r.matches_played);
      const goals = parseInt(r.total_goals);
      const assists = parseInt(r.total_assists);
      const cleanSheets = parseInt(r.total_clean_sheets);

      const playerXG = goals > 0 ? (matches / goals).toFixed(1) : '-';
      const playerXA = assists > 0 ? (matches / assists).toFixed(1) : '-';
      const playerXCS = cleanSheets > 0 ? (matches / cleanSheets).toFixed(1) : '-';

      const name = `${r.firstName} ${r.lastName}`.trim();
      console.log(`| ${name} | ${matches} | ${goals} | ${assists} | ${cleanSheets} | **${playerXG}** | **${playerXA}** | **${playerXCS}** |`);
    });

    // Calculate League Averages
    let totalMatchesAll = 0;
    let totalGoalsAll = 0;
    let totalAssistsAll = 0;
    let totalCleanSheetsAll = 0;

    rows.forEach(r => {
      totalMatchesAll += parseInt(r.matches_played);
      totalGoalsAll += parseInt(r.total_goals);
      totalAssistsAll += parseInt(r.total_assists);
      totalCleanSheetsAll += parseInt(r.total_clean_sheets);
    });

    const leagueXG = totalGoalsAll > 0 ? (totalMatchesAll / totalGoalsAll).toFixed(1) : '-';
    const leagueXA = totalAssistsAll > 0 ? (totalMatchesAll / totalAssistsAll).toFixed(1) : '-';
    const leagueXCS = totalCleanSheetsAll > 0 ? (totalMatchesAll / totalCleanSheetsAll).toFixed(1) : '-';

    console.log('\n=== Averages ===');
    console.log(`Total Players: ${rows.length}`);
    console.log(`Total Matches: ${totalMatchesAll}`);
    console.log(`Total Goals: ${totalGoalsAll}`);
    console.log(`Total Assists: ${totalAssistsAll}`);
    console.log(`Total Clean Sheets: ${totalCleanSheetsAll}`);
    console.log(`League xG: ${leagueXG}`);
    console.log(`League xA: ${leagueXA}`);
    console.log(`League xCS: ${leagueXCS}`);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

main();

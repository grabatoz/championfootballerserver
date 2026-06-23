require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'salman1209',
  password: process.env.DB_PASSWORD || 'Malik,g12',
});

async function main() {
  const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4';
  
  // Total match_statistics rows
  const statsCount = await pool.query(`
    SELECT COUNT(*) FROM match_statistics ms 
    JOIN "Matches" m ON ms.match_id = m.id 
    WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED');
  `, [leagueId]);
  console.log('Total match_statistics rows for Season 7 FNF:', statsCount.rows[0].count);

  // Let's count wins using homeTeamGoals vs awayTeamGoals and lineup
  const lineupWins = await pool.query(`
    SELECT COUNT(*) FROM (
      SELECT uhm."userId", m.id 
      FROM "UserHomeMatches" uhm
      JOIN "Matches" m ON uhm."matchId" = m.id
      WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
      AND m."homeTeamGoals" > m."awayTeamGoals"
      UNION ALL
      SELECT uam."userId", m.id 
      FROM "UserAwayMatches" uam
      JOIN "Matches" m ON uam."matchId" = m.id
      WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
      AND m."awayTeamGoals" > m."homeTeamGoals"
    ) AS wins;
  `, [leagueId]);
  console.log('Total lineup wins:', lineupWins.rows[0].count);

  // Let's check the total goals/assists/clean_sheets from match_statistics
  const totals = await pool.query(`
    SELECT SUM(goals) as goals, SUM(assists) as assists, SUM(clean_sheets) as clean_sheets
    FROM match_statistics ms
    JOIN "Matches" m ON ms.match_id = m.id
    WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED');
  `, [leagueId]);
  console.log('Totals from match_statistics:', totals.rows[0]);

  // Let's query how many distinct matches have match_statistics entries
  const distinctMatches = await pool.query(`
    SELECT COUNT(DISTINCT ms.match_id) FROM match_statistics ms
    JOIN "Matches" m ON ms.match_id = m.id
    WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED');
  `, [leagueId]);
  console.log('Distinct matches with stats:', distinctMatches.rows[0].count);

  await pool.end();
}
main();

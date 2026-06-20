const { Sequelize } = require('sequelize');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres';
const sequelize = new Sequelize(databaseUrl, { logging: false });

async function main() {
  try {
    // 1. Search for Leagues containing 'FNF'
    const [leagues] = await sequelize.query(`
      SELECT id, name FROM "Leagues"
      WHERE name ILIKE '%FNF%' OR name ILIKE '%fnf%'
    `);
    console.log('=== FNF Leagues ===');
    console.table(leagues);

    // 2. Search for Seasons of those leagues
    const leagueIds = leagues.map(l => `'${l.id}'`).join(',');
    if (leagueIds) {
      const [seasons] = await sequelize.query(`
        SELECT id, name, "leagueId", "seasonNumber"
        FROM "Seasons"
        WHERE "leagueId" IN (${leagueIds})
        ORDER BY "seasonNumber"
      `);
      console.log('=== Seasons for FNF Leagues ===');
      console.table(seasons);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

main();

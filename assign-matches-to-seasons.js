const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log
});

async function assignMatchesToSeasons() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    // Get all leagues
    const [leagues] = await sequelize.query(`
      SELECT id FROM "Leagues";
    `);

    console.log(`Found ${leagues.length} leagues`);

    for (const league of leagues) {
      // Find Season 1 for this league
      const [seasons] = await sequelize.query(`
        SELECT id FROM "Seasons" 
        WHERE "leagueId" = :leagueId AND "seasonNumber" = 1
        LIMIT 1;
      `, {
        replacements: { leagueId: league.id }
      });

      if (seasons.length === 0) {
        console.log(`⚠️ No Season 1 found for league ${league.id}, creating one...`);
        
        // Create Season 1 for this league
        await sequelize.query(`
          INSERT INTO "Seasons" (id, "leagueId", "seasonNumber", name, "isActive", "startDate", "createdAt", "updatedAt")
          VALUES (uuid_generate_v4(), :leagueId, 1, 'Season 1', true, NOW(), NOW(), NOW());
        `, {
          replacements: { leagueId: league.id }
        });

        // Get the newly created season
        const [newSeasons] = await sequelize.query(`
          SELECT id FROM "Seasons" 
          WHERE "leagueId" = :leagueId AND "seasonNumber" = 1
          LIMIT 1;
        `, {
          replacements: { leagueId: league.id }
        });

        if (newSeasons.length > 0) {
          const seasonId = newSeasons[0].id;
          
          // Assign all matches without seasonId to Season 1
          const [result] = await sequelize.query(`
            UPDATE "Matches" 
            SET "seasonId" = :seasonId 
            WHERE "leagueId" = :leagueId AND "seasonId" IS NULL;
          `, {
            replacements: { seasonId, leagueId: league.id }
          });

          console.log(`✅ Created Season 1 and assigned matches for league ${league.id}`);
        }
      } else {
        const seasonId = seasons[0].id;
        
        // Assign all matches without seasonId to Season 1
        const [result] = await sequelize.query(`
          UPDATE "Matches" 
          SET "seasonId" = :seasonId 
          WHERE "leagueId" = :leagueId AND "seasonId" IS NULL;
        `, {
          replacements: { seasonId, leagueId: league.id }
        });

        console.log(`✅ Assigned matches to Season 1 for league ${league.id}`);
      }
    }

    console.log('✅ All matches assigned to seasons successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

assignMatchesToSeasons();

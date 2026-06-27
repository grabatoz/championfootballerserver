import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';

async function run() {
  try {
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';
    console.log("Running SQL for userId:", userId);

    const query = `
      SELECT DISTINCT
        l.id::text AS id,
        l.name,
        l.active,
        COALESCE(l.archived, false) AS archived,
        l.image,
        l."maxGames",
        l."createdAt" AS "createdAt",
        COALESCE(
          (SELECT "userId"::text FROM "LeagueAdmin" la2 WHERE la2."leagueId" = l.id LIMIT 1),
          (SELECT "userId"::text FROM "LeagueMember" lm_first WHERE lm_first."leagueId" = l.id ORDER BY "createdAt" ASC LIMIT 1)
        ) AS "adminId",
        (SELECT TRIM(COALESCE(u."firstName", '') || ' ' || COALESCE(u."lastName", '')) 
         FROM "users" u 
         WHERE u.id = COALESCE(
           (SELECT "userId" FROM "LeagueAdmin" la3 WHERE la3."leagueId" = l.id LIMIT 1),
           (SELECT "userId" FROM "LeagueMember" lm4 WHERE lm4."leagueId" = l.id ORDER BY "createdAt" ASC LIMIT 1)
         ) LIMIT 1) AS "adminName",
        (SELECT COUNT(*)::int FROM "LeagueMember" lm2 WHERE lm2."leagueId" = l.id) AS "memberCount"
      FROM "Leagues" l
      LEFT JOIN "LeagueMember" lm
        ON lm."leagueId" = l.id
      LEFT JOIN "LeagueAdmin" la
        ON la."leagueId" = l.id
      WHERE lm."userId" = :userId
         OR la."userId" = :userId
      ORDER BY l."createdAt" DESC
    `;

    const rows = await sequelize.query(query, {
      replacements: { userId },
      type: QueryTypes.SELECT
    });

    console.log("Result rows:");
    console.dir(rows, { depth: null });

  } catch (err) {
    console.error("Error executing query:", err);
  } finally {
    process.exit(0);
  }
}

run();

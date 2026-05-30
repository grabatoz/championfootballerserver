const { Sequelize, QueryTypes } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

const xpAchievements = [
  { id: "hat_trick_3_matches", xp: 100 },
  { id: "captain_5_wins", xp: 150 },
  { id: "assist_10_consecutive", xp: 200 },
  { id: "scoring_10_consecutive", xp: 250 },
  { id: "captain_performance_3", xp: 300 },
  { id: "motm_4_consecutive", xp: 350 },
  { id: "clean_sheet_5_wins", xp: 400 },
  { id: "top_spot_10_matches", xp: 450 },
  { id: "consecutive_10_victories", xp: 500 },
];

async function run() {
  try {
    const achievementXpValuesSql = xpAchievements
      .map((achievement) => `('${String(achievement.id).replace(/'/g, "''")}', ${Number(achievement.xp) || 0})`)
      .join(', ');

    const year = 2022;
    const query = `
      WITH base AS (
        SELECT
          u."id",
          u."firstName",
          u."lastName",
          u."profilePicture",
          u."position",
          u."positionType",
          u."country",
          (COALESCE(stats."matchXP", 0) + CASE WHEN EXTRACT(YEAR FROM u."createdAt") = :year THEN COALESCE(ach."achievementXP", 0) ELSE 0 END)::int AS "totalXP",
          COALESCE(stats."matchCount", 0)::int AS "matches",
          CASE
            WHEN COALESCE(stats."matchCount", 0) > 0
            THEN ROUND((COALESCE(stats."matchXP", 0) + CASE WHEN EXTRACT(YEAR FROM u."createdAt") = :year THEN COALESCE(ach."achievementXP", 0) ELSE 0 END)::numeric / stats."matchCount", 2)
            ELSE 0
          END AS "avgXP"
        FROM "users" u
        LEFT JOIN (
          SELECT
            ms2."user_id",
            SUM(ms2.xp_awarded) AS "matchXP",
            COUNT(DISTINCT ms2."match_id") AS "matchCount"
          FROM "match_statistics" ms2
          INNER JOIN "Matches" m2 ON m2."id" = ms2."match_id"
            AND m2."status" = 'RESULT_PUBLISHED'
            AND EXTRACT(YEAR FROM m2."date") = :year
          GROUP BY ms2."user_id"
        ) stats ON stats."user_id" = u."id"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ax.xp), 0)::int AS "achievementXP"
          FROM unnest(COALESCE(u."achievements", ARRAY[]::text[])) AS achv(id)
          LEFT JOIN (
            VALUES ${achievementXpValuesSql}
          ) AS ax(id, xp) ON ax.id = achv.id
        ) ach ON TRUE
        WHERE u."lastName" != 'Guest' AND COALESCE(u."provider", '') <> 'guest'
          AND (COALESCE(stats."matchXP", 0) + CASE WHEN EXTRACT(YEAR FROM u."createdAt") = :year THEN COALESCE(ach."achievementXP", 0) ELSE 0 END) > 0
      )
      SELECT
        b.*,
        DENSE_RANK() OVER (ORDER BY "totalXP" DESC) AS "rank",
        COUNT(*) OVER ()::int AS "totalCount"
      FROM base b
      ORDER BY "totalXP" DESC, b."id" ASC
    `;

    const rows = await sequelize.query(query, {
      replacements: { year },
      type: QueryTypes.SELECT,
    });

    console.log(`Found ${rows.length} players for 2022:`);
    rows.forEach(r => {
      console.log(`- Rank ${r.rank}: ${r.firstName} ${r.lastName} (XP: ${r.totalXP}, Matches: ${r.matches}, AvgXP: ${r.avgXP})`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

run();

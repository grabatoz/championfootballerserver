import { QueryInterface } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    // Drop old full-table unique constraints/indexes on ("leagueId","seasonNumber") if present.
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT con.conname
          FROM pg_constraint
          WHERE conrelid = '"Seasons"'::regclass
            AND contype = 'u'
            AND (
              SELECT array_agg(att.attname ORDER BY u.ordinality)
              FROM unnest(conkey) WITH ORDINALITY AS u(attnum, ordinality)
              JOIN pg_attribute att ON att.attrelid = conrelid AND att.attnum = u.attnum
            ) = ARRAY['leagueId','seasonNumber']
        LOOP
          EXECUTE format('ALTER TABLE "Seasons" DROP CONSTRAINT %I', r.conname);
        END LOOP;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT idx.relname AS index_name
          FROM pg_index ind
          JOIN pg_class idx ON idx.oid = ind.indexrelid
          JOIN pg_class rel ON rel.oid = ind.indrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE nsp.nspname = 'public'
            AND rel.relname = 'Seasons'
            AND ind.indisunique = true
            AND ind.indisprimary = false
            AND (
              SELECT array_agg(att.attname ORDER BY k.ordinality)
              FROM unnest(ind.indkey) WITH ORDINALITY AS k(attnum, ordinality)
              JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
            ) = ARRAY['leagueId','seasonNumber']
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I.%I', 'public', r.index_name);
        END LOOP;
      END $$;
    `);

    // Enforce uniqueness only on non-deleted seasons.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "seasons_league_id_season_number_active"
      ON "Seasons" ("leagueId", "seasonNumber")
      WHERE "deleted" = false;
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "seasons_league_id_season_number_active";
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Seasons"
      ADD CONSTRAINT "seasons_league_id_season_number"
      UNIQUE ("leagueId", "seasonNumber");
    `);
  },
};

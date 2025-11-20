import { QueryInterface } from 'sequelize';

/*
  Sets up Postgres trigger functions + triggers to emit NOTIFY with JSON payloads
  on changes to core tables. Fully Sequelize-compatible via raw queries.
*/

export async function up(qi: QueryInterface) {
  // Create a generic notifier function once
  await qi.sequelize.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'cf_notify_json'
      ) THEN
        CREATE OR REPLACE FUNCTION cf_notify_json(channel TEXT, payload JSON) RETURNS void AS $$
        BEGIN
          PERFORM pg_notify(channel, payload::text);
        END;
        $$ LANGUAGE plpgsql;
      END IF;
    END
    $$;
  `);

  // Helper to conditionally create trigger for a given table and operation
  async function addTrigger(tableReg: string, channel: string, op: 'INSERT'|'UPDATE'|'DELETE', payloadSql: string, triggerName: string) {
    await qi.sequelize.query(`
      DO $$
      DECLARE
        tbl regclass;
      BEGIN
        SELECT to_regclass('${tableReg}') INTO tbl;
        IF tbl IS NOT NULL THEN
          -- Drop existing trigger if present to keep idempotent
          IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${triggerName}') THEN
            EXECUTE 'DROP TRIGGER IF EXISTS ${triggerName} ON ' || tbl::text || ' CASCADE';
          END IF;

          EXECUTE '
            CREATE TRIGGER ${triggerName}
            AFTER ${op} ON ' || tbl::text || '
            FOR EACH ROW
            EXECUTE FUNCTION cf_notify_${channel}_tg()
          ';
        END IF;
      END
      $$;
    `);
  }

  // Create per-channel trigger wrapper functions for performance (no dynamic SQL inside trigger)
  await qi.sequelize.query(`
    CREATE OR REPLACE FUNCTION cf_notify_match_updates_tg() RETURNS trigger AS $$
    DECLARE payload JSON;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        payload := json_build_object('id', OLD.id, 'deleted', true);
      ELSE
        payload := json_build_object('id', NEW.id, 'leagueId', NEW."leagueId", 'status', NEW.status);
      END IF;
      PERFORM cf_notify_json('match_updates', payload);
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION cf_notify_league_updates_tg() RETURNS trigger AS $$
    DECLARE payload JSON;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        payload := json_build_object('id', OLD.id, 'deleted', true);
      ELSE
        payload := json_build_object('id', NEW.id, 'name', NEW.name);
      END IF;
      PERFORM cf_notify_json('league_updates', payload);
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION cf_notify_vote_updates_tg() RETURNS trigger AS $$
    DECLARE payload JSON;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        payload := json_build_object('matchId', OLD."matchId", 'voterId', OLD."voterId", 'votedForId', OLD."votedForId", 'deleted', true);
      ELSE
        payload := json_build_object('matchId', NEW."matchId", 'voterId', NEW."voterId", 'votedForId', NEW."votedForId");
      END IF;
      PERFORM cf_notify_json('vote_updates', payload);
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION cf_notify_stats_updates_tg() RETURNS trigger AS $$
    DECLARE payload JSON;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        payload := json_build_object('matchId', OLD.match_id, 'playerId', OLD.user_id, 'deleted', true);
      ELSE
        payload := json_build_object('matchId', NEW.match_id, 'playerId', NEW.user_id, 'action', TG_OP);
      END IF;
      PERFORM cf_notify_json('stats_updates', payload);
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
  `);

  // Create triggers on both quoted and unquoted table identifiers where applicable (idempotent)
  // Matches
  await addTrigger('public."Matches"', 'match_updates', 'INSERT', '', 'cf_match_updates_ai');
  await addTrigger('public."Matches"', 'match_updates', 'UPDATE', '', 'cf_match_updates_au');
  await addTrigger('public."Matches"', 'match_updates', 'DELETE', '', 'cf_match_updates_ad');

  // Leagues
  await addTrigger('public."Leagues"', 'league_updates', 'INSERT', '', 'cf_league_updates_ai');
  await addTrigger('public."Leagues"', 'league_updates', 'UPDATE', '', 'cf_league_updates_au');
  await addTrigger('public."Leagues"', 'league_updates', 'DELETE', '', 'cf_league_updates_ad');

  // Votes
  await addTrigger('public."Votes"', 'vote_updates', 'INSERT', '', 'cf_vote_updates_ai');
  await addTrigger('public."Votes"', 'vote_updates', 'DELETE', '', 'cf_vote_updates_ad');

  // MatchStatistics: try both naming conventions
  await addTrigger('public."MatchStatistics"', 'stats_updates', 'INSERT', '', 'cf_stats_updates_ai');
  await addTrigger('public."MatchStatistics"', 'stats_updates', 'UPDATE', '', 'cf_stats_updates_au');
  await addTrigger('public."MatchStatistics"', 'stats_updates', 'DELETE', '', 'cf_stats_updates_ad');
  await addTrigger('public.match_statistics', 'stats_updates', 'INSERT', '', 'cf_stats_updates_ai_snake');
  await addTrigger('public.match_statistics', 'stats_updates', 'UPDATE', '', 'cf_stats_updates_au_snake');
  await addTrigger('public.match_statistics', 'stats_updates', 'DELETE', '', 'cf_stats_updates_ad_snake');
}

export async function down(qi: QueryInterface) {
  // Drop triggers if exist
  const drops = [
    'cf_match_updates_ai','cf_match_updates_au','cf_match_updates_ad',
    'cf_league_updates_ai','cf_league_updates_au','cf_league_updates_ad',
    'cf_vote_updates_ai','cf_vote_updates_ad',
    'cf_stats_updates_ai','cf_stats_updates_au','cf_stats_updates_ad',
    'cf_stats_updates_ai_snake','cf_stats_updates_au_snake','cf_stats_updates_ad_snake'
  ];
  for (const tg of drops) {
    await qi.sequelize.query(`
      DO $$
      DECLARE r RECORD; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE 'DROP TRIGGER IF EXISTS ${tg} ON ' || quote_ident(r.tablename);
        END LOOP;
      END $$;
    `);
  }

  // Drop helper trigger functions
  await qi.sequelize.query(`
    DROP FUNCTION IF EXISTS cf_notify_match_updates_tg() CASCADE;
    DROP FUNCTION IF EXISTS cf_notify_league_updates_tg() CASCADE;
    DROP FUNCTION IF EXISTS cf_notify_vote_updates_tg() CASCADE;
    DROP FUNCTION IF EXISTS cf_notify_stats_updates_tg() CASCADE;
  `);

  // Keep cf_notify_json in case other objects depend; safe to keep. Uncomment to drop:
  // await qi.sequelize.query('DROP FUNCTION IF EXISTS cf_notify_json(TEXT, JSON) CASCADE;');
}

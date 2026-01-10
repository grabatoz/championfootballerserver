import { Sequelize, QueryTypes } from 'sequelize';
import dotenv from 'dotenv';
import { QueryInterface, DataTypes } from 'sequelize';

dotenv.config();


// Use the full Neon connection string
const sequelize = new Sequelize(process.env.DATABASE_URL as string, {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false, // Keep disabled for performance
  pool: {
    max: 30, // Balanced: Good for VPS without overloading
    min: 10, // Balanced: Enough ready connections
    acquire: 60000, // 60s to allow retry
    idle: 10000, // Standard idle timeout
    evict: 10000, // Standard eviction time
  },
  dialectOptions: {
    ssl: false, // Disabled for VPS database that doesn't support SSL
    keepAlive: true, // CRITICAL: Keep connection alive on VPS
    keepAliveInitialDelayMs: 10000, // Keep alive every 10s
    application_name: 'championfootballer-api',
    // 🚀 Performance: Timeouts for queries
    statement_timeout: 30000, // 30 second query timeout
    idle_in_transaction_session_timeout: 10000, // 10 second idle timeout
  },
  // Performance optimizations
  benchmark: false,
  retry: {
    max: 3, // 🔧 Standard: 3 retries on connection issues
    timeout: 30000, // 🔧 FIXED: 30s retry timeout (was 10s, causing errors!)
  }
});

// Ensure additional columns exist on users table (resilient, idempotent)
async function ensureUserProviderColumn(): Promise<void> {
  const qi = sequelize.getQueryInterface() as QueryInterface;
  try {
    const table = await qi.describeTable('users');
    if (!table.provider) {
      await qi.addColumn('users', 'provider', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    }
  } catch (err: any) {
    // Skip silently if table doesn't exist yet
    if (err?.message?.includes('does not exist') || err?.original?.code === '42P01') {
      return;
    }
    throw err;
  }
}

async function ensureUserLocationColumns(): Promise<void> {
  const qi = sequelize.getQueryInterface() as QueryInterface;
  try {
    const table = await qi.describeTable('users');
    if (!table.country) {
      await qi.addColumn('users', 'country', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    }
    if (!table.state) {
      await qi.addColumn('users', 'state', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    }
    if (!table.city) {
      await qi.addColumn('users', 'city', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    }
  } catch (err: any) {
    if (err?.message?.includes('does not exist') || err?.original?.code === '42P01') {
      return;
    }
    throw err;
  }
}

let initialized = false;

// Initialize database function
export async function initializeDatabase() {
  try {
    if (initialized) return;
    await sequelize.authenticate();

    // SAFE: Only validate model metadata locally; don't alter DB
    await sequelize.sync({
      force: false,
      alter: false
    });

    await ensureUserProviderColumn();
    await ensureUserLocationColumns();

    // Ensure DB NOTIFY/LISTEN infrastructure and triggers (idempotent)
    try {
      await sequelize.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cf_notify_json') THEN
            CREATE OR REPLACE FUNCTION cf_notify_json(channel TEXT, payload JSON) RETURNS void AS $func$
            BEGIN
              PERFORM pg_notify(channel, payload::text);
            END;
            $func$ LANGUAGE plpgsql;
          END IF;
        END
        $$;
      `);

      await sequelize.query(`
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

      // Helper to add trigger if table exists
      const addTrigger = async (tableReg: string, triggerName: string, op: string, func: string) => {
        await sequelize.query(`
          DO $$
          DECLARE tbl regclass; BEGIN
            SELECT to_regclass('${tableReg}') INTO tbl;
            IF tbl IS NOT NULL THEN
              IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='${triggerName}') THEN
                EXECUTE 'DROP TRIGGER IF EXISTS ${triggerName} ON ' || tbl::text;
              END IF;
              EXECUTE 'CREATE TRIGGER ${triggerName} AFTER ${op} ON ' || tbl::text || ' FOR EACH ROW EXECUTE FUNCTION ${func}()';
            END IF;
          END $$;
        `);
      };

      // Matches
      await addTrigger('public."Matches"', 'cf_match_updates_ai', 'INSERT', 'cf_notify_match_updates_tg');
      await addTrigger('public."Matches"', 'cf_match_updates_au', 'UPDATE', 'cf_notify_match_updates_tg');
      await addTrigger('public."Matches"', 'cf_match_updates_ad', 'DELETE', 'cf_notify_match_updates_tg');
      // Leagues
      await addTrigger('public."Leagues"', 'cf_league_updates_ai', 'INSERT', 'cf_notify_league_updates_tg');
      await addTrigger('public."Leagues"', 'cf_league_updates_au', 'UPDATE', 'cf_notify_league_updates_tg');
      await addTrigger('public."Leagues"', 'cf_league_updates_ad', 'DELETE', 'cf_notify_league_updates_tg');
      // Votes
      await addTrigger('public."Votes"', 'cf_vote_updates_ai', 'INSERT', 'cf_notify_vote_updates_tg');
      await addTrigger('public."Votes"', 'cf_vote_updates_ad', 'DELETE', 'cf_notify_vote_updates_tg');
      // MatchStatistics (try both naming conventions)
      await addTrigger('public."MatchStatistics"', 'cf_stats_updates_ai', 'INSERT', 'cf_notify_stats_updates_tg');
      await addTrigger('public."MatchStatistics"', 'cf_stats_updates_au', 'UPDATE', 'cf_notify_stats_updates_tg');
      await addTrigger('public."MatchStatistics"', 'cf_stats_updates_ad', 'DELETE', 'cf_notify_stats_updates_tg');
      await addTrigger('public.match_statistics', 'cf_stats_updates_ai_snake', 'INSERT', 'cf_notify_stats_updates_tg');
      await addTrigger('public.match_statistics', 'cf_stats_updates_au_snake', 'UPDATE', 'cf_notify_stats_updates_tg');
      await addTrigger('public.match_statistics', 'cf_stats_updates_ad_snake', 'DELETE', 'cf_notify_stats_updates_tg');

      console.log('[DB] NOTIFY triggers ensured.');
    } catch (trgErr) {
      console.warn('[DB] Failed ensuring NOTIFY triggers:', trgErr);
    }

    initialized = true;
    console.log('✅ DB ready - All data safe, schema validated');
  } catch (e: any) {
    console.error('❌ Database initialization error:', e.message);
    // Continue anyway if it's just an index conflict
    if (e.parent?.code === '42P07') {
      console.log('⚠️ Note: Some indexes already exist (this is normal)');
      await ensureUserProviderColumn();
      await ensureUserLocationColumns();
      console.log('✅ DB ready');
    } else {
      throw e;
    }
  }
}

// Function to initialize and test connection
export async function testConnection() {
  try {
    await initializeDatabase();
    console.log('✅ PostgreSQL connected successfully.');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

// Remove top-level await and call testConnection normally
// Guard against multiple executions in dev/hot-reload scenarios
if (!(global as any).__DB_TESTED__) {
  (global as any).__DB_TESTED__ = true;
  testConnection();
}

process.on('SIGINT', async () => {
  try {
    await sequelize.close();
    console.log('Database connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('Error closing database connection:', error);
    process.exit(1);
  }
});

export default sequelize;





// import { Sequelize, QueryTypes } from 'sequelize';
// import dotenv from 'dotenv';
// import { QueryInterface, DataTypes } from 'sequelize';

// dotenv.config();

// // Use the full Neon connection string
// const sequelize = new Sequelize(process.env.DATABASE_URL as string, {
//   dialect: 'postgres',
//   protocol: 'postgres',
//   logging: false, // Keep disabled for performance
//   pool: {
//     max: 20, // Increased connection pool for better performance
//     min: 5,
//     acquire: 30000,
//     idle: 10000,
//   },
//   dialectOptions: {
//     ssl: {
//       require: true,
//       rejectUnauthorized: false, // For Neon — allows self-signed certs
//     },
//   },
//   // Performance optimizations
//   benchmark: false,
//   retry: {
//     max: 3
//   }
// });

// async function ensureUserProviderColumn(): Promise<void> {
//   const qi = sequelize.getQueryInterface() as QueryInterface;
//   const table = await qi.describeTable('users');
//   if (!table.provider) {
//     await qi.addColumn('users', 'provider', {
//       type: DataTypes.STRING(255),
//       allowNull: true,
//     });
//   }
// }

// // Initialize database function
// export async function initializeDatabase() {
//   try {
//     await sequelize.authenticate();
//     // If you use migrations, REMOVE sync({ alter: true }) and run migrations instead.
//     await sequelize.sync(); // no alter to avoid repeated ALTER TABLE generation
//     await ensureUserProviderColumn(); // idempotent
//     console.log('DB ready');
//   } catch (e) {
//     console.error('Database initialization error:', e);
//     throw e;
//   }
// }

// // Function to initialize and test connection
// export async function testConnection() {
//   try {
//     await sequelize.authenticate();
//     console.log('✅ PostgreSQL connected successfully.');
    
//     // Call initializeDatabase to sync with alter: true
//     await initializeDatabase();
    
//   } catch (error) {
//     console.error('❌ Database connection failed:', error);
//     process.exit(1);
//   }
// }

// // Remove top-level await and call testConnection normally
// testConnection();

// process.on('SIGINT', async () => {
//   try {
//     await sequelize.close();
//     console.log('Database connection closed.');
//     process.exit(0);
//   } catch (error) {
//     console.error('Error closing database connection:', error);
//     process.exit(1);
//   }
// });

// export default sequelize;



















// import { Sequelize } from 'sequelize';
// import dotenv from 'dotenv';

// dotenv.config();

// const sequelize = new Sequelize({
//   dialect: 'postgres',
//   host: process.env.DB_HOST || 'localhost',
//   port: parseInt(process.env.DB_PORT || '5432'),
//   username: process.env.DB_USER || 'postgres',
//   password: process.env.DB_PASSWORD || 'salman1209',
//   database: process.env.DB_NAME || 'championfootballer',
//   logging: false, // Set to console.log to see SQL queries
//   pool: {
//     max: 5,
//     min: 0,
//     acquire: 30000,
//     idle: 10000
//   }
// });

// // Test connection and sync database
// const initializeDatabase = async () => {
//   try {
//     await sequelize.authenticate();
//     console.log('✅ PostgreSQL connected successfully.');
    
//     // Sync all models with database
//     await sequelize.sync({ alter: true });
//     console.log('✅ Database synchronized successfully.');
//   } catch (error) {
//     console.error('❌ Database initialization error:', error);
//     // Don't exit process, just log error and retry
//     setTimeout(initializeDatabase, 5000); // Retry after 5 seconds
//   }
// };

// // Initialize database
// initializeDatabase();

// // Handle process termination
// process.on('SIGINT', async () => {
//   try {
//     await sequelize.close();
//     console.log('Database connection closed.');
//     process.exit(0);
//   } catch (error) {
//     console.error('Error closing database connection:', error);
//     process.exit(1);
//   }
// });

// export default sequelize;










// import { Sequelize } from 'sequelize';
// import dotenv from 'dotenv';

// dotenv.config();
// console.log("ENV DB_USER:", process.env.DB_USER);


// const sequelize = new Sequelize(
//   process.env.DB_NAME || 'postgres',
//   process.env.DB_USER || 'salman1209',
//   process.env.DB_PASSWORD || 'Malik,g12',
//   {
//     host: process.env.DB_HOST || 'championfootballerserver.postgres.database.azure.com',
//     dialect: 'postgres',
//     port: parseInt(process.env.DB_PORT || '5432'),
//     dialectOptions: {
//       ssl: {
//         require: true,
//         rejectUnauthorized: false,
//       },
//     },
//     logging: false,
//   }
// );


// // Test connection
// const initializeDatabase = async () => {
//   try {
//     await sequelize.authenticate();
//     console.log('✅ Connected to Azure PostgreSQL successfully.');
//     await sequelize.sync({ alter: true });
//     console.log('✅ Database synced.');
//   } catch (error) {
//         console.error('Error closing database connection:', error);
//         process.exit(1);
//       }
// };

// initializeDatabase();

// export default sequelize;

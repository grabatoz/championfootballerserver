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
    max: 30, // 🚀 Optimized: Increased from 20 to 30 for better concurrency
    min: 10, // 🚀 Optimized: Increased from 5 to 10 for faster response
    acquire: 30000,
    idle: 10000,
    evict: 5000, // 🚀 Optimized: Faster cleanup of idle connections
  },
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false, // For Neon — allows self-signed certs
    },
    keepAlive: true, // IMPORTANT: Keep connection alive
    keepAliveInitialDelayMs: 10000, // Send keepalive every 10s
    // 🚀 Performance: Add query timeouts to prevent hanging
    statement_timeout: 30000, // 30 second timeout for queries
    idle_in_transaction_session_timeout: 10000, // 10 second timeout for idle transactions
  },
  // Performance optimizations
  benchmark: false,
  retry: {
    max: 3
  }
});

async function ensureUserProviderColumn(): Promise<void> {
  const qi = sequelize.getQueryInterface() as QueryInterface;
  const table = await qi.describeTable('users');
  if (!table.provider) {
    await qi.addColumn('users', 'provider', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  }
}

async function ensureUserLocationColumns(): Promise<void> {
  const qi = sequelize.getQueryInterface() as QueryInterface;
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
}

// Initialize database function
export async function initializeDatabase() {
  try {
    await sequelize.authenticate();
    
    // 🔒 SAFE: Only validate schema, don't alter or drop anything
    // This ensures all your data stays exactly as it is
    await sequelize.sync({ 
      force: false,  // ✅ SAFE: Never drop tables
      alter: false   // ✅ SAFE: Never modify existing columns
    });
    
    await ensureUserProviderColumn(); // idempotent
    await ensureUserLocationColumns(); // idempotent
    
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
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connected successfully.');
    
    // Call initializeDatabase to sync with alter: true
    await initializeDatabase();
    
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

// Remove top-level await and call testConnection normally
testConnection();

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

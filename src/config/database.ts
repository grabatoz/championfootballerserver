import { Sequelize, QueryTypes } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

// Use the full Neon connection string
const sequelize = new Sequelize(process.env.DATABASE_URL as string, {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false, // Keep disabled for performance
  pool: {
    max: 20, // Increased connection pool for better performance
    min: 5,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false, // For Neon — allows self-signed certs
    },
  },
  // Performance optimizations
  benchmark: false,
  retry: {
    max: 3
  }
});

// Initialize database function
export async function initializeDatabase() {
  try {
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connected successfully.');
    
    // Clean orphan data before sync
    try {
      await sequelize.query(`
        DELETE FROM "MatchGuests" 
        WHERE "matchId" NOT IN (SELECT id FROM matches) OR "matchId" IS NULL
      `);
    } catch (cleanupError) {
      console.log('Database cleanup skipped (tables may not exist yet)');
    }
    
    // Sync database (create tables if they don't exist)
    await sequelize.sync({ alter: false }); // Use false to avoid schema conflicts
    console.log('✅ Database synchronized.');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    // Don't throw error to prevent server crash
  }
}

// Function to initialize and test connection
const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connected successfully.');

    await sequelize.sync({ alter: true });
    console.log('✅ Database synchronized successfully.');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    setTimeout(testConnection, 5000);
  }
};

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

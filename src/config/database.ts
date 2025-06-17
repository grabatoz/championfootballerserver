import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize(
  process.env.DB_NAME || 'championfootballer',     // Database name
  process.env.DB_USER || 'postgres',               // Username
  process.env.DB_PASSWORD || 'salman1209',         // Password
  {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 10,                    // Increased max connections
      min: 2,                     // Increased min connections
      acquire: 60000,            // Increased acquire timeout
      idle: 30000,               // Increased idle timeout
      evict: 1000                // Run eviction check every 1 second
    },
    dialectOptions: {
      connectTimeout: 30000,     // Increased connection timeout
      statement_timeout: 60000,  // Set statement timeout
      idle_in_transaction_session_timeout: 60000 // Set idle transaction timeout
    },
    define: {
      timestamps: true,
      underscored: true,
    },
    retry: {
      max: 3,                    // Maximum retry attempts
      match: [/Deadlock/i, /Connection lost/i] // Retry on these errors
    }
  }
);

// Test connection and sync database
const initializeDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connected successfully.');
    
    // Sync all models with database
    await sequelize.sync({ alter: true });
    console.log('✅ Database synchronized successfully.');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    // Don't exit process, just log error and retry
    setTimeout(initializeDatabase, 5000); // Retry after 5 seconds
  }
};

// Initialize database
initializeDatabase();

// Handle process termination
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

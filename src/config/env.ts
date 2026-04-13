import dotenv from 'dotenv';

dotenv.config();

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[ENV] Missing required environment variable: ${name}`);
  }
  return value.trim();
};

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';

export const DATABASE_URL = requiredEnv('DATABASE_URL');
export const JWT_SECRET = requiredEnv('JWT_SECRET');


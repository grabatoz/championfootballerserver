import { Context } from 'koa';
 
export interface CustomContext extends Context {
  session?: {
    userId: string;
  };
} 
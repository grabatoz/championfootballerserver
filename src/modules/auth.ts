import { Context, Next } from "koa";
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env';

interface CustomContext extends Context {
  state: {
    user?: { userId: string; email: string; iat: number; exp: number; };
  };
}

const verifyToken = async (ctx: CustomContext) => {
  try {
    const authHeader = ctx.request.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header:", {
        method: ctx.method,
        path: ctx.path,
      });
      ctx.throw(401, "No authorization header");
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      ctx.throw(401, "No token provided");
    }

    // Keep auth logs minimal and avoid token leakage.
    if (process.env.NODE_ENV !== 'production') {
      console.log("Token validation:", {
        tokenLength: token.length,
        tokenParts: token.split('.').length,
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
      iat: number;
      exp: number;
    };
    ctx.state.user = decoded;

    // Check if token is expiring soon (less than 1 hour remaining)
    const currentTime = Math.floor(Date.now() / 1000);
    const timeUntilExpiry = decoded.exp - currentTime;

    if (timeUntilExpiry < 3600) {
      const newToken = jwt.sign(
        { userId: decoded.userId, email: decoded.email },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      ctx.set('X-New-Token', newToken);
      ctx.set('X-Token-Refreshed', 'true');

      if (process.env.NODE_ENV !== 'production') {
        console.log("Token refreshed for user:", decoded.userId, {
          timeRemaining: timeUntilExpiry,
          newExpiry: '7d',
        });
      }
    }
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    if (err.name === 'TokenExpiredError') {
      ctx.throw(401, "jwt expired");
    } else if (err.name === 'JsonWebTokenError') {
      ctx.throw(401, "Invalid token");
    } else {
      console.error("Auth error:", err.message, "path:", ctx.path);
      ctx.throw(401, err.message || "Invalid access token");
    }
  }
};

/**
 * Public endpoint with no authentication
 */
export const none = async (_ctx: Context, next: Next) => {
  await next();
};

/**
 * Bearer token required in "Authorization" header
 */
export const required = async (ctx: CustomContext, next: Next) => {
  await verifyToken(ctx);
  if (ctx.status !== 401) {
    await next();
  }
};

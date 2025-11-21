import { Context, Next } from "koa"
import jwt from 'jsonwebtoken';

// IMPORTANT: Use the same default as social auth and routes/auth.ts
const JWT_SECRET = process.env.JWT_SECRET || "catsay's hello";

interface CustomContext extends Context {
  state: {
    user?: { userId: string; email: string; iat: number; exp: number; }
  };
}


const verifyToken = async (ctx: CustomContext) => {
  try {
    const authHeader = ctx.request.get("Authorization")
    if (!authHeader) {
      // Better logging for debugging
      console.error("❌ No authorization header:", {
        method: ctx.method,
        path: ctx.path,
        headers: Object.keys(ctx.request.headers),
        hasAuthHeader: !!authHeader
      });
      ctx.throw(401, "No authorization header")
    }

    const token = authHeader.split(" ")[1]
    if (!token) {
      console.error("❌ No token in authorization header:", {
        authHeader: authHeader.substring(0, 20)
      });
      ctx.throw(401, "No token provided")
    }

    // Debug: Log token info (first/last few chars only for security)
    console.log("🔐 Token validation:", {
      tokenLength: token.length,
      tokenStart: token.substring(0, 10),
      tokenEnd: token.substring(token.length - 10),
      tokenParts: token.split('.').length // JWT should have 3 parts
    });

    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string; iat: number; exp: number; };
    ctx.state.user = decoded;

    // Check if token is expiring soon (less than 1 hour remaining)
    const currentTime = Math.floor(Date.now() / 1000);
    const timeUntilExpiry = decoded.exp - currentTime;
    
    if (timeUntilExpiry < 3600) { // Less than 1 hour
      // Generate new token with extended expiry
      const newToken = jwt.sign(
        { userId: decoded.userId, email: decoded.email }, 
        JWT_SECRET, 
        { expiresIn: '7d' }
      );
      
      // Send new token in response header
      ctx.set('X-New-Token', newToken);
      ctx.set('X-Token-Refreshed', 'true');
      
      console.log("🔄 Token refreshed for user:", decoded.userId, {
        timeRemaining: timeUntilExpiry,
        newExpiry: '7d'
      });
    }

  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      console.error("❌ JWT Expired:", {
        expiredAt: error.expiredAt,
        message: error.message,
        path: ctx.path
      });
      ctx.throw(401, "jwt expired");
    } else if (error.name === 'JsonWebTokenError') {
      console.error("❌ JWT Invalid:", error.message, "path:", ctx.path);
      ctx.throw(401, "Invalid token");
    } else {
      console.error("Auth error:", error.message, "path:", ctx.path)
      ctx.throw(401, error.message || "Invalid access token")
    }
  }
}

/**
 * Public endpoint with no authentication
 */
export const none = async (_ctx: Context, next: Next) => {
  await next()
}

/**
 * Bearer token required in "Authorization" header
 */
export const required = async (ctx: CustomContext, next: Next) => {
  await verifyToken(ctx)
  if(ctx.status !== 401) {
    await next()
  }
}

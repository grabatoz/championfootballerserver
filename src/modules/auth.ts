import { Context, Next } from "koa"
import { Session } from "../models"

interface CustomContext extends Context {
  token?: string;
  session?: Session;
}

const verifyToken = async (ctx: CustomContext) => {
  try {
    const authHeader = ctx.request.get("Authorization")
    if (!authHeader) {
      throw new Error("No authorization header")
    }

    const token = authHeader.split(" ")[1]
    if (!token) {
      throw new Error("No token provided")
    }

    ctx.token = token

    const session = await Session.findOne({
      where: {
        id: token,
      },
    })

    if (!session) {
      throw new Error("Session not found")
    }

    // Check if session is expired (24 hours)
    const sessionAge = Date.now() - new Date(session.createdAt).getTime()
    if (sessionAge > 24 * 60 * 60 * 1000) {
      await session.destroy()
      throw new Error("Session expired")
    }

    ctx.session = session
  } catch (error: any) {
    console.error("Auth error:", error.message)
    ctx.throw(401, error.message || "Invalid access token")
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
  await next()
}

import { Context } from "koa"
import db from "./database"
import { League, User } from "../models"
import { ModelStatic } from "sequelize"

type ModelName = keyof typeof db.models;

/**
 * @returns 5 random numbers
 */
export const getLoginCode = () => {
    const randomString = (length: number, chars: string) => {
        let result = ""
        for (let i = length; i > 0; --i)
            result += chars[Math.floor(Math.random() * chars.length)]
        return result
    }

    return randomString(5, "1234567890")
}

/**
 * @returns 6 random numbers or letters
 */
export const getInviteCode = () => {
    const randomString = (length: number, chars: string) => {
        let result = ""
        for (let i = length; i > 0; --i)
            result += chars[Math.floor(Math.random() * chars.length)]
        return result
    }

    return randomString(6, "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ")
}

/**
 * Will use :id URL param and determine if objects exists and on this platform.
 */
export const doesObjectExist = async (
    ctx: Context,
    param: string | { [key: string]: any }
) => {
    let object: { [key: string]: any }
    if (typeof param === "string") {
        if (!(param in db.models))
            throw new Error(`Invalid model name: ${param}`)

        const model = db.models[param as ModelName] as ModelStatic<any>;
        object = await model.findByPk(ctx.params.id)
    } else {
        object = param
    }

    if (!object) ctx.throw(404, `Object not found.`)
}

/**
 * Throws if user is not league admin
 */
export async function verifyLeagueAdmin(ctx: Context, leagueId: string) {
    const league = await League.findByPk(leagueId, {
        include: [{
            model: User,
            as: 'admins'
        }]
    }) as League & { admins: any[] };

    if (!league?.admins?.find((user: { id: string }) => user.id === ctx.session.userId)) {
        ctx.throw(403, "You are not a league admin.")
    }
}
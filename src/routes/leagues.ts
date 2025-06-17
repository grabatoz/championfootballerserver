import router from "../modules/router"
import { required } from "../modules/auth"
import { League, Match, User } from "../models"
import { getInviteCode, verifyLeagueAdmin } from "../modules/utils"
import sendEmail from "../modules/sendEmail"

router.post("/leagues", required, async (ctx) => {
  const { name } = ctx.request.body.league as League

  const league = await League.create({
    name,
    maxGames: 20,
    inviteCode: await getInviteCode(),
    active: true,
    showPoints: true
  } as any)

  await league.addUser(ctx.session.userId)
  await league.addAdmin(ctx.session.userId)

  ctx.response.body = { league }
})

router.patch("/leagues/:id", required, async (ctx) => {
  const { name, active, maxGames, users, admins, showPoints } = ctx.request.body
    .league as League & {
    users: string[]
    admins: string[]
  }

  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id)
  if (!league) ctx.throw(404, "League not found")
  const foundLeague = league as NonNullable<typeof league>

  if (users) {
    await foundLeague.setUsers([])
  }

  if (admins) {
    await foundLeague.setAdmins([])
  }

  await foundLeague.update({
    name,
    active,
    maxGames,
    showPoints,
  })

  if (users) {
    await foundLeague.addUsers(users)
  }

  if (admins) {
    await foundLeague.addAdmins(admins)
  }

  ctx.response.status = 200
})

router.post("/leagues/:id/matches", required, async (ctx) => {
  const {
    awayTeamName,
    homeTeamName,
    start,
    end,
    location,
    homeTeamGoals,
    awayTeamGoals,
    notes,
    awayTeamUsers,
    homeTeamUsers,
  } = ctx.request.body.match as Match & {
    homeTeamUsers?: string[]
    awayTeamUsers?: string[]
  }

  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id, {
    include: [
      {
        model: Match,
        as: 'matches'
      },
      {
        model: User,
        as: 'users'
      }
    ]
  })

  if (!league) ctx.throw(404, "League not found")
  const foundLeague = league as NonNullable<typeof league>

  if (foundLeague.maxGames && foundLeague.matches.length >= foundLeague.maxGames) {
    ctx.throw(403, "This league has reached the maximum number of games.")
  }

  const match = await Match.create({
    awayTeamName,
    homeTeamName,
    homeTeamGoals,
    awayTeamGoals,
    start,
    end,
    location,
    notes,
    leagueId: ctx.params.id,
    date: start,
    status: 'scheduled'
  } as any)

  if (homeTeamUsers) {
    await match.addHomeTeamUsers(homeTeamUsers)
  }

  if (awayTeamUsers) {
    await match.addAwayTeamUsers(awayTeamUsers)
  }

  const matchWithUsers = await Match.findByPk(match.id, {
    include: [
      {
        model: User,
        as: 'awayTeamUsers'
      },
      {
        model: User,
        as: 'homeTeamUsers'
      }
    ]
  })

  async function sendEmails() {
    for (const user of foundLeague.users as unknown as { email: string }[]) {
      if (!user.email) continue
      await sendEmail({
        to: user.email,
        subject: `A new match has been created in Champion Footballer!`,
        html: `<div><img src="https://i.imgur.com/7wOPUk7.png" style="height:30px;" /></div><a href="http://championfootballer.com/leagues/${match.leagueId}/matches/${match.id}" style="font-size:20px;font-weight:bold;margin-top:10px;">Mark your availability and view the match in your dashboard</a>`,
      })
    }
  }
  sendEmails()

  ctx.response.body = { match: matchWithUsers }
})

router.post("/leagues/:inviteCode/join", required, async (ctx) => {
  const league = await League.findOne({
    where: {
      inviteCode: ctx.params.inviteCode,
    }
  })

  if (!league) {
    ctx.throw(404, "Invalid invite code.")
  }
  const foundLeague = league as NonNullable<typeof league>

  await foundLeague.addUser(ctx.session.userId)

  ctx.response.status = 200
})

router.post("/leagues/:id/leave", required, async (ctx) => {
  const league = await League.findByPk(ctx.params.id)
  if (!league) ctx.throw(404, "League not found")
  const foundLeague = league as NonNullable<typeof league>

  await foundLeague.removeUser(ctx.session.userId)

  ctx.response.status = 200
})

router.delete("/leagues/:id", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id)
  if (!league) ctx.throw(404, "League not found")
  const foundLeague = league as NonNullable<typeof league>

  await foundLeague.destroy()

  ctx.response.status = 200
})

router.delete("/leagues/:id/users/:userId", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id)
  if (!league) ctx.throw(404, "League not found")
  const foundLeague = league as NonNullable<typeof league>

  await foundLeague.removeUser(ctx.params.userId)

  ctx.response.status = 200
})

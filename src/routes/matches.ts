import router from "../modules/router"
import { required } from "../modules/auth"
import { Match, MatchStatistics, User, Vote } from "../models"
import { verifyLeagueAdmin } from "../modules/utils"

router.patch("/matches/:id", required, async (ctx) => {
  const {
    awayTeamGoals,
    start,
    end,
    homeTeamGoals,
    awayTeamName,
    location,
    homeTeamName,
    homeTeamUsers,
    awayTeamUsers,
    notes,
  } = ctx.request.body.match as Match & {
    homeTeamUsers?: string[]
    awayTeamUsers?: string[]
  }

  const match = await Match.findByPk(ctx.params.id)
  if (!match) ctx.throw(404, "Match not found")
  const foundMatch = match as NonNullable<typeof match>

  await verifyLeagueAdmin(ctx, foundMatch.leagueId)

  if (homeTeamUsers || awayTeamUsers) {
    await foundMatch.setHomeTeamUsers([])
    await foundMatch.setAwayTeamUsers([])
  }

  await foundMatch.update({
    notes,
    awayTeamGoals,
    start,
    end,
    homeTeamGoals,
    awayTeamName,
    location,
    homeTeamName,
  })

  if (homeTeamUsers) {
    await foundMatch.addHomeTeamUsers(homeTeamUsers)
  }

  if (awayTeamUsers) {
    await foundMatch.addAwayTeamUsers(awayTeamUsers)
  }

  ctx.response.status = 200
})

router.post("/matches/:id/availability", required, async (ctx) => {
  const { action } = ctx.request.query
  const match = await Match.findByPk(ctx.params.id)
  if (!match) ctx.throw(404, "Match not found")
  const foundMatch = match as NonNullable<typeof match>

  if (action === "available") {
    await foundMatch.addAvailableUser(ctx.session.userId)
  } else if (action === "unavailable") {
    await foundMatch.removeAvailableUser(ctx.session.userId)
  }

  ctx.response.status = 200
})

router.post("/matches/:id/statistics", required, async (ctx) => {
  const { statistics, userId } = ctx.request.body as {
    userId: string
    statistics: {
      type: string
      value: number
    }[]
  }

  await MatchStatistics.destroy({
    where: {
      user_id: userId,
      match_id: ctx.params.id,
    },
  })

  for (const statistic of statistics) {
    await MatchStatistics.create({
      type: statistic.type,
      value: statistic.value,
      match_id: ctx.params.id,
      user_id: userId,
      goals: 0,
      assists: 0,
      yellowCards: 0,
      redCards: 0,
      saves: 0,
      cleanSheets: 0
    } as any)
  }

  ctx.response.status = 200
})

router.post("/matches/:id/guest-users", required, async (ctx) => {
  const { firstName, lastName } = ctx.request.body.user as { firstName: string; lastName: string }

  const match = await Match.findByPk(ctx.params.id)
  if (!match) ctx.throw(404, "Match not found")
  const foundMatch = match as NonNullable<typeof match>

  await verifyLeagueAdmin(ctx, foundMatch.leagueId)

  // Create user
  const user = await User.create({
    firstName,
    lastName,
    matchGuestForId: ctx.params.id,
    attributes: {
      Pace: 50,
      Passing: 50,
      Physical: 50,
      Shooting: 50,
      Defending: 50,
      Dribbling: 50,
    },
  } as any)

  // Add to league
  const league = await foundMatch.getLeague()
  await league.addUser(user.id)

  // Make available for match
  await foundMatch.addAvailableUser(user.id)

  ctx.response.status = 200
})

router.delete(
  "/matches/:id/guest-users/:userId",
  required,
  async (ctx) => {
    const match = await Match.findByPk(ctx.params.id)
    if (!match) ctx.throw(404, "Match not found")
    const foundMatch = match as NonNullable<typeof match>

    await verifyLeagueAdmin(ctx, foundMatch.leagueId)

    // Delete user
    await User.destroy({
      where: {
        id: ctx.params.userId,
      },
    })

    ctx.response.status = 200
  }
)

router.post("/matches/:id/votes", required, async (ctx) => {
  const { userId } = ctx.request.body as {
    userId: string
  }

  await Vote.destroy({
    where: {
      matchId: ctx.params.id,
      byUserId: ctx.session.userId,
    },
  })

  await Vote.create({
    matchId: ctx.params.id,
    byUserId: ctx.session.userId,
    forUserId: userId,
  })

  ctx.response.status = 200
})

router.delete("/matches/:id", required, async (ctx) => {
  const match = await Match.findByPk(ctx.params.id)
  if (!match) ctx.throw(404, "Match not found")
  const foundMatch = match as NonNullable<typeof match>

  await verifyLeagueAdmin(ctx, foundMatch.leagueId)

  await foundMatch.destroy()

  ctx.response.status = 200
})

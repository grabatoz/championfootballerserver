import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
const { League, Match, User } = models;
import { getInviteCode, verifyLeagueAdmin } from '../modules/utils';
import type { LeagueAttributes } from '../models/League';
import { transporter } from '../modules/sendEmail';
import { Op } from 'sequelize';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';

const router = new Router({ prefix: '/leagues' });

// Get all leagues for the current user
router.get("/", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  try {
    const user = await User.findByPk(ctx.session.userId, {
      include: [{
        model: League,
        as: 'leagues',
        include: [
          { model: User, as: 'members' },
          { model: User, as: 'administeredLeagues' },
          {
            model: Match,
            as: 'matches',
            include: [
              { model: User, as: 'homeTeamUsers' },
              { model: User, as: 'awayTeamUsers' },
              { model: User, as: 'statistics' }
            ]
          }
        ]
      }]
    });

    if (!user) {
      ctx.throw(404, "User not found");
      return;
    }

    ctx.body = { success: true, leagues: (user as any).leagues || [] };
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.throw(500, "Failed to retrieve leagues.");
  }
});

// Get league details by ID
router.get("/:id", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");
  
  const leagueId = ctx.params.id;

  try {
    // Automatically update status of matches that have ended
    await Match.update(
      { status: 'completed' },
      {
        where: {
          leagueId: leagueId,
          status: 'scheduled',
          end: { [Op.lt]: new Date() }
        }
      }
    );
  } catch (error) {
    console.error('Error auto-updating match statuses:', error);
    // We don't throw here, as fetching the league is the primary purpose
  }

  const league = await League.findByPk(ctx.params.id, {
    include: [
      {
        model: User,
        as: 'members',
        // attributes: ['id', 'firstName', 'lastName', 'email', 'profilePicture']
      },
      {
        model: User,
        as: 'administeredLeagues',
        // attributes: ['id', 'firstName', 'lastName', 'email', 'profilePicture']
      },
      {
        model: Match,
        as: 'matches',
        include: [
          {
            model: User,
            as: 'homeTeamUsers',
            // attributes: ['id', 'firstName', 'lastName']
          },
          {
            model: User,
            as: 'awayTeamUsers',
            // attributes: ['id', 'firstName', 'lastName']
          },
          {
            model: User,
            as: 'availableUsers',
            // attributes: ['id', 'firstName', 'lastName', 'email', 'profilePicture']
          },
          {
            model: User,
            as: 'homeCaptain',
            // attributes: ['id', 'firstName', 'lastName'],
          },
          {
            model: User,
            as: 'awayCaptain',
            // attributes: ['id', 'firstName', 'lastName'],
          }
        ]
      }
    ]
  });

  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  // Award XP to all members for this league
  for (const member of (league as any).members || []) {
    await calculateAndAwardXPAchievements(member.id, league.id);
  }

  const isMember = (league as any).members?.some((member: any) => member.id === ctx.session!.userId);
  const isAdmin = (league as any).administeredLeagues?.some((admin: any) => admin.id === ctx.session!.userId);

  if (!isMember && !isAdmin) {
    ctx.throw(403, "You don't have access to this league");
  }

  ctx.body = { 
    success: true,
    league: {
      id: league.id,
      name: league.name,
      inviteCode: league.inviteCode,
      createdAt: league.createdAt,
      members: (league as any).members || [],
      administrators: (league as any).administeredLeagues || [],
      matches: (league as any).matches || [],
      active: league.active,
      maxGames: league.maxGames,
      showPoints: league.showPoints,
    }
  };
});

// Create a new league
router.post("/", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) {
    ctx.throw(401, "Unauthorized");
  }

  const { name } = ctx.request.body as { name: string };

  if (!name || typeof name !== 'string' || name.trim() === '') {
    ctx.throw(400, "League name is required and must be a non-empty string.");
  }

  try {
    const league = await League.create({
      name: name.trim(),
      maxGames: 20,
      inviteCode: await getInviteCode(),
      active: true,
      showPoints: true,
    } as any);

    const user = await User.findByPk(ctx.session!.userId);
    if (!user) {
        ctx.throw(404, "User not found");
        return;
    }

    await (league as any).addMember(user.id);
    await (league as any).addAdministeredLeague(user.id);

    const emailHtml = `
      <h1>Congratulations!</h1>
      <p>You have successfully created the league: <strong>${league.name}</strong>.</p>
      <p>Your invite code is: <strong>${league.inviteCode}</strong>. Share it with others to join!</p>
      <p>Happy competing!</p>
    `;

    await transporter.sendMail({
      to: user.email,
      subject: `You've created a new league: ${league.name}`,
      html: emailHtml,
    });
    console.log(`Creation email sent to ${user.email}`);

    ctx.status = 201; 
    ctx.body = {
      success: true,
      message: "League created successfully",
      league: {
        id: league.id,
        name: league.name,
        inviteCode: league.inviteCode,
        createdAt: league.createdAt,
      },
    };
  } catch (error) {
    console.error("Error creating league:", error);
    ctx.throw(500, "Something went wrong. Please contact support.");
  }
});

// Update a league's general settings
router.patch("/:id", required, async (ctx) => {
  const { name, active, maxGames, users, admins, showPoints } = ctx.request.body
    .league as LeagueAttributes & {
    users: string[]
    admins: string[]
  }

  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id)
  if (!league) {
    ctx.throw(404, "League not found")
    return;
  }

  if (users) {
    await (league as any).setMembers(users)
  }

  if (admins) {
    await (league as any).setAdministeredLeagues(admins)
  }

  await league.update({
    name,
    active,
    maxGames,
    showPoints,
  })

  ctx.status = 200;
  ctx.body = { success: true, message: "League updated successfully." };
})

// Delete a league
router.del("/:id", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  await league.destroy();

  ctx.status = 204; // No Content
});

// Create a new match in a league
router.post("/:id/matches", required, async (ctx) => {
  const {
    awayTeamName,
    homeTeamName,
    location,
    awayTeamUsers,
    homeTeamUsers,
    date,
    end: rawEnd,
  } = ctx.request.body as {
    homeTeamUsers?: string[],
    awayTeamUsers?: string[],
    date: string,
    end: string, // Expecting end time as ISO string
    awayTeamName: string,
    homeTeamName: string,
    location: string,
  };

  if (!homeTeamName || !awayTeamName || !date) {
    ctx.throw(400, "Missing required match details.");
  }

  await verifyLeagueAdmin(ctx, ctx.params.id)

  const league = await League.findByPk(ctx.params.id, {
    include: [{ model: Match, as: 'matches' }]
  });

  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  if (league.maxGames && (league as any).matches.length >= league.maxGames) {
    ctx.throw(403, "This league has reached the maximum number of games.")
  }

  const matchDate = new Date(date);
  const endDate = rawEnd ? new Date(rawEnd) : new Date(matchDate.getTime() + 90 * 60000); // Default to 90 mins if not provided

  const match = await Match.create({
    awayTeamName,
    homeTeamName,
    location,
    leagueId: ctx.params.id,
    date: matchDate,
    start: matchDate,
    end: endDate,
    status: 'scheduled'
  } as any);
  console.log('match create',match)

  if (homeTeamUsers) {
    await (match as any).addHomeTeamUsers(homeTeamUsers)
  }

  if (awayTeamUsers) {
    await (match as any).addAwayTeamUsers(awayTeamUsers)
  }

  const matchWithUsers = await Match.findByPk(match.id, {
    include: [
      { model: User, as: 'awayTeamUsers' },
      { model: User, as: 'homeTeamUsers' }
    ]
  });

  ctx.status = 201;
  ctx.body = {
    success: true,
    message: "Match scheduled successfully.",
    match: matchWithUsers,
  };
});

// Get a single match's details
router.get("/:leagueId/matches/:matchId", required, async (ctx) => {
  const { matchId } = ctx.params;
  
  const match = await Match.findByPk(matchId, {
    include: [
      {
        model: User,
        as: 'homeTeamUsers',
        // attributes: ['id', 'firstName', 'lastName'],
      },
      {
        model: User,
        as: 'awayTeamUsers',
        // attributes: ['id', 'firstName', 'lastName'],
      },
    ],
  });

  if (!match) {
    ctx.throw(404, "Match not found");
  }

  ctx.body = {
    success: true,
    match,
  };
});

// Update a match's details
router.patch("/:leagueId/matches/:matchId", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.leagueId);

  const { matchId } = ctx.params;
  const match = await Match.findByPk(matchId);

  const {
    homeTeamName,
    awayTeamName,
    date,
    location,
    homeTeamUsers,
    awayTeamUsers,
  } = ctx.request.body as {
    homeTeamName: string;
    awayTeamName: string;
    date: string;
    location: string;
    homeTeamUsers: string[];
    awayTeamUsers: string[];
  };

  const matchDate = new Date(date);

  if (!match) {
    ctx.throw(404, "Match not found");
    return;
  }

  await match.update({
    homeTeamName,
    awayTeamName,
    date: matchDate,
    start: matchDate,
    end: matchDate,
    location,
  });

  if (homeTeamUsers) {
    await (match as any).setHomeTeamUsers(homeTeamUsers);
  }
  if (awayTeamUsers) {
    await (match as any).setAwayTeamUsers(awayTeamUsers);
  }

  const updatedMatch = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ],
  });

  ctx.body = {
    success: true,
    message: "Match updated successfully.",
    match: updatedMatch,
  };
});

// Join a league with an invite code
router.post("/join", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");
  
  const { inviteCode } = ctx.request.body;
  if (!inviteCode) {
    ctx.throw(400, "Invite code is required");
  }

  const league = await League.findOne({
    where: { inviteCode: inviteCode }
  });

  if (!league) {
    ctx.throw(404, "Invalid invite code.");
    return;
  }

  const isAlreadyMember = await (league as any).hasMember(ctx.session!.userId);

  if (isAlreadyMember) {
    ctx.body = {
      success: false,
      message: "You have already joined this league."
    };
    return;
  }

  const user = await User.findByPk(ctx.session!.userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  await (league as any).addMember(user.id);

  const emailHtml = `
    <h1>Welcome to the League!</h1>
    <p>You have successfully joined <strong>${league.name}</strong>.</p>
    <p>Get ready for some exciting competition!</p>
  `;
  
  await transporter.sendMail({
    to: user.email,
    subject: `Welcome to ${league.name}`,
    html: emailHtml,
  });
  console.log(`Join email sent to ${user.email}`);

  ctx.body = { 
    success: true,
    message: "Successfully joined league",
    league: {
      id: league.id,
      name: league.name,
      inviteCode: league.inviteCode
    }
  };
});

// Leave a league
router.post("/:id/leave", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");
  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  await (league as any).removeMember(ctx.session!.userId);

  ctx.response.status = 200;
});

// Remove a user from a league
router.delete("/:id/users/:userId", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  await (league as any).removeMember(ctx.params.userId);

  ctx.response.status = 200;
});

// Add XP calculation when league ends
router.patch('/:id/end', required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });

  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  // Mark league as inactive
  await league.update({ active: false });

  // Calculate final XP for all league members
  for (const member of (league as any).members || []) {
    try {
      await calculateAndAwardXPAchievements(member.id, league.id);
      console.log(`Final XP calculated for user ${member.id} in league ${league.id}`);
    } catch (error) {
      console.error(`Error calculating final XP for user ${member.id}:`, error);
    }
  }

  ctx.status = 200;
  ctx.body = { success: true, message: "League ended and final XP calculated" };
});

export default router;

import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
const { League, Match, User } = models;
import { getInviteCode, verifyLeagueAdmin } from '../modules/utils';
import type { LeagueAttributes } from '../models/League';
import { transporter } from '../modules/sendEmail';
import { Op } from 'sequelize';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';

const router = new Router({ prefix: '/leagues' });

// Get all leagues for the current user (for /leagues/user)
router.get('/user', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `user_leagues_${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  try {
    const user = await User.findByPk(userId, {
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

    const result = { success: true, leagues: (user as any).leagues || [] };
    console.log('result',result);
    
    cache.set(cacheKey, result, 600); // cache for 30 seconds
    ctx.body = result;
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.throw(500, "Failed to retrieve leagues.");
  }
});

// Get all leagues for the current user
router.get("/", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  try {
    const user = await User.findByPk(ctx.state.user.userId, {
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
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  
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

  // (XP calculation removed from here)

  const isMember = (league as any).members?.some((member: any) => member.id === ctx.state.user!.userId);
  const isAdmin = (league as any).administeredLeagues?.some((admin: any) => admin.id === ctx.state.user!.userId);

  if (!isMember && !isAdmin) {
    // New logic: allow if user has ever shared any league with any member
    // 1. Get all league IDs for the current user
    const userWithLeagues = await User.findByPk(ctx.state.user!.userId, {
      include: [{ model: League, as: 'leagues', attributes: ['id'] }]
    });
    const userLeagueIds = (userWithLeagues as any)?.leagues?.map((l: any) => l.id) || [];
    // 2. For each member of this league, check if there is any overlap
    const memberIds = (league as any).members?.map((m: any) => m.id) || [];
    let hasCommonLeague = false;
    for (const memberId of memberIds) {
      if (memberId === ctx.state.user!.userId) continue;
      const memberWithLeagues = await User.findByPk(memberId, {
        include: [{ model: League, as: 'leagues', attributes: ['id'] }]
      });
      const memberLeagueIds = (memberWithLeagues as any)?.leagues?.map((l: any) => l.id) || [];
      if (userLeagueIds.some((id: any) => memberLeagueIds.includes(id))) {
        hasCommonLeague = true;
        break;
      }
    }
    if (!hasCommonLeague) {
      ctx.throw(403, "You don't have access to this league");
    }
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
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const { name, maxGames, showPoints } = ctx.request.body as LeagueAttributes;
  if (!name) {
    ctx.throw(400, "League name is required");
  }

  try {
    const newLeague = await League.create({
      name,
      inviteCode: getInviteCode(),
      maxGames,
      showPoints,
    } as any);

    const user = await User.findByPk(ctx.state.user.userId);
    if (user) {
      await (newLeague as any).addMember(user);
      await (newLeague as any).addAdministeredLeague(user);

    const emailHtml = `
      <h1>Congratulations!</h1>
        <p>You have successfully created the league: <strong>${newLeague.name}</strong>.</p>
        <p>Your invite code is: <strong>${newLeague.inviteCode}</strong>. Share it with others to join!</p>
      <p>Happy competing!</p>
    `;

    await transporter.sendMail({
      to: user.email,
        subject: `You've created a new league: ${newLeague.name}`,
      html: emailHtml,
    });
    console.log(`Creation email sent to ${user.email}`);
    }

    // Update cache with new league
    const newLeagueData = {
      id: newLeague.id,
      name: newLeague.name,
      inviteCode: newLeague.inviteCode,
      createdAt: newLeague.createdAt,
      maxGames,
      showPoints,
      active: true,
      members: [],
      administrators: [user],
      matches: []
    };

    // Update all user-specific league caches
    cache.updateArray(`user_leagues_${ctx.state.user.userId}`, newLeagueData);
    
    // Clear any general leagues cache to ensure fresh data
    cache.clearPattern('leagues_all');

    ctx.status = 201; 
    ctx.body = {
      success: true,
      message: "League created successfully",
      league: {
        id: newLeague.id,
        name: newLeague.name,
        inviteCode: newLeague.inviteCode,
        createdAt: newLeague.createdAt,
      },
    };
  } catch (error) {
    console.error("Error creating league:", error);
    ctx.throw(500, "Something went wrong. Please contact support.");
  }
});

// New endpoint to update league status
router.patch("/:id/status", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const leagueId = ctx.params.id;
  const { active } = ctx.request.body as { active: boolean };

  // Verify user is an admin of the league
  await verifyLeagueAdmin(ctx, leagueId);

  const league = await League.findByPk(leagueId, {
    include: [{ model: User, as: 'members' }]
  });

  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  // Update the league status
  league.active = active;
  await league.save();

  // If the league is being made inactive, run final XP calculation for all members
  if (active === false) {
    console.log(`League ${league.name} (${league.id}) is ending. Running final XP calculation.`);
    for (const member of (league as any).members || []) {
      try {
        await calculateAndAwardXPAchievements(member.id, league.id);
      } catch (error) {
        console.error(`Error during final XP calculation for user ${member.id} in league ${league.id}:`, error);
      }
    }
  }

  // Update cache with league status change
  const updatedLeagueData = {
    id: leagueId,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active,
    members: (league as any).members || [],
    administrators: [],
    matches: []
  };

  // Update all user league caches
  const memberIds = (league as any).members.map((m: any) => m.id);
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.body = { success: true, league };
});

// Update a league's general settings
router.patch("/:id", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  const { name, maxGames, showPoints, active, admins } = ctx.request.body as (LeagueAttributes & { active?: boolean, admins?: string[] });

  await league.update({
    name,
    maxGames,
    showPoints,
    active,
  });

  if (admins && admins.length > 0) {
    const newAdmin = await User.findByPk(admins[0]);
    if (newAdmin) {
      await (league as any).setAdministeredLeagues([newAdmin]);
    } else {
      ctx.throw(404, 'Selected admin user not found.');
      return;
    }
  }

  // Update cache with league changes
  const updatedLeagueData = {
    id: ctx.params.id,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: []
  };

  // Update all user league caches
  const leagueWithMembers = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.status = 200;
  ctx.body = { success: true, message: "League updated successfully." };
});

// Delete a league
router.del("/:id", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  // Get league members before deletion
  const leagueWithMembers = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];

  await league.destroy();

  // Remove league from all user caches
  memberIds.forEach((memberId: string) => {
    cache.removeFromArray(`user_leagues_${memberId}`, ctx.params.id);
  });

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
    homeCaptain, // <-- add this
    awayCaptain  // <-- add this
  } = ctx.request.body as {
    homeTeamUsers?: string[],
    awayTeamUsers?: string[],
    date: string,
    end: string, // Expecting end time as ISO string
    awayTeamName: string,
    homeTeamName: string,
    location: string,
    homeCaptain?: string, // <-- add this
    awayCaptain?: string  // <-- add this
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
    status: 'scheduled',
    homeCaptainId: homeCaptain || null, // <-- save captain
    awayCaptainId: awayCaptain || null  // <-- save captain
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

  // Update cache with new match
  const newMatchData = {
    id: match.id,
    homeTeamName,
    awayTeamName,
    location,
    leagueId: ctx.params.id,
    date: matchDate,
    start: matchDate,
    end: endDate,
    status: 'scheduled',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamUsers: (matchWithUsers as any)?.homeTeamUsers || [],
    awayTeamUsers: (matchWithUsers as any)?.awayTeamUsers || []
  };

  // Update matches cache
  cache.updateArray('matches_all', newMatchData);

  // Update league cache with new match
  const updatedLeagueData = {
    id: ctx.params.id,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: [newMatchData]
  };

  // Update all user league caches
  const leagueWithMembers = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
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
    homeCaptainId,
    awayCaptainId,
  } = ctx.request.body as {
    homeTeamName: string;
    awayTeamName: string;
    date: string;
    location: string;
    homeTeamUsers: string[];
    awayTeamUsers: string[];
    homeCaptainId:string;
    awayCaptainId:string;
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
    homeCaptainId: ctx.request.body.homeCaptainId, // <-- add this
    awayCaptainId: ctx.request.body.awayCaptainId, // <-- add this
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

  // Update cache with updated match
  const updatedMatchData = {
    id: matchId,
    homeTeamName,
    awayTeamName,
    location,
    leagueId: match.leagueId,
    date: matchDate,
    start: matchDate,
    end: matchDate,
    status: match.status,
    homeCaptainId: ctx.request.body.homeCaptainId,
    awayCaptainId: ctx.request.body.awayCaptainId,
    homeTeamUsers: (updatedMatch as any)?.homeTeamUsers || [],
    awayTeamUsers: (updatedMatch as any)?.awayTeamUsers || []
  };

  // Update matches cache
  cache.updateArray('matches_all', updatedMatchData);

  ctx.body = {
    success: true,
    message: "Match updated successfully.",
    match: updatedMatch,
  };
});

// Join a league with an invite code
router.post("/join", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  
  const { inviteCode } = ctx.request.body as { inviteCode: string };
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

  const isAlreadyMember = await (league as any).hasMember(ctx.state.user.userId);

  if (isAlreadyMember) {
    ctx.body = {
      success: false,
      message: "You have already joined this league."
    };
    return;
  }

  const user = await User.findByPk(ctx.state.user.userId);
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

  // Update cache with joined league
  const joinedLeagueData = {
    id: league.id,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: []
  };

  // Update user's league cache
  cache.updateArray(`user_leagues_${ctx.state.user.userId}`, joinedLeagueData);
  
  // Clear any general leagues cache to ensure fresh data
  cache.clearPattern('leagues_all');

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
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  await (league as any).removeMember(ctx.state.user.userId);

  // Remove league from user's cache
  cache.removeFromArray(`user_leagues_${ctx.state.user.userId}`, league.id);
  
  // Clear any general leagues cache to ensure fresh data
  cache.clearPattern('leagues_all');

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

// GET /leagues/:leagueId/xp - Return XP for each member in the league (sum of xpAwarded for completed matches in this league)
router.get('/:leagueId/xp', async (ctx) => {
  const { leagueId } = ctx.params;
  const league = await models.League.findByPk(leagueId, {
    include: [{ model: models.User, as: 'members' }]
  });
  if (!league) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'League not found' };
    return;
  }
  // Fix type for members
  //@ts-ignore
  const members = (league.members || []) as any[];
  const xp: Record<string, number> = {};
  for (const member of members) {
    // Get all completed matches for this league for this user
    const stats = await models.MatchStatistics.findAll({
      where: { user_id: member.id },
      include: [{
        model: models.Match,
        as: 'match',
        where: { leagueId, status: 'completed' }
      }]
    });
    xp[member.id] = stats.reduce((sum, s) => sum + (s.xpAwarded || 0), 0);
  }
  ctx.body = { success: true, xp };
});

// Debug endpoint: Get XP breakdown for a user in a league
router.get('/:leagueId/xp-breakdown/:userId', required, async (ctx) => {
  const { leagueId, userId } = ctx.params;
  const league = await League.findByPk(leagueId);
  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }
  // Get all completed matches in this league
  const matches = await Match.findAll({
    where: { leagueId, status: 'completed' },
    order: [['date', 'ASC']],
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ]
  });
  const matchIds = matches.map(m => m.id);
  const allStats = await MatchStatistics.findAll({ where: { match_id: matchIds, user_id: userId } });
  const allVotes = await Vote.findAll({ where: { matchId: matchIds } });
  const breakdown: any[] = [];
  let runningTotal = 0;
  for (const match of matches) {
    const homeTeamUsers = ((match as any).homeTeamUsers || []);
    const awayTeamUsers = ((match as any).awayTeamUsers || []);
    const isOnTeam = [...homeTeamUsers, ...awayTeamUsers].some((u: any) => u.id === userId);
    if (!isOnTeam) continue;
    const homeGoals = match.homeTeamGoals ?? 0;
    const awayGoals = match.awayTeamGoals ?? 0;
    let teamResult: 'win' | 'draw' | 'lose' = 'lose';
    const isHome = homeTeamUsers.some((u: any) => u.id === userId);
    const isAway = awayTeamUsers.some((u: any) => u.id === userId);
    if (isHome && homeGoals > awayGoals) teamResult = 'win';
    else if (isAway && awayGoals > homeGoals) teamResult = 'win';
    else if (homeGoals === awayGoals) teamResult = 'draw';
    let matchXP = 0;
    const details: any[] = [];
    if (teamResult === 'win') { matchXP += xpPointsTable.winningTeam; details.push({ type: 'Win', points: xpPointsTable.winningTeam }); }
    else if (teamResult === 'draw') { matchXP += xpPointsTable.draw; details.push({ type: 'Draw', points: xpPointsTable.draw }); }
    else { matchXP += xpPointsTable.losingTeam; details.push({ type: 'Loss', points: xpPointsTable.losingTeam }); }
    const stat = allStats.find(s => s.match_id === match.id);
    if (stat) {
      if (stat.goals) { const pts = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals; matchXP += pts; details.push({ type: 'Goals', count: stat.goals, points: pts }); }
      if (stat.assists) { const pts = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists; matchXP += pts; details.push({ type: 'Assists', count: stat.assists, points: pts }); }
      if (stat.cleanSheets) { const pts = xpPointsTable.cleanSheet * stat.cleanSheets; matchXP += pts; details.push({ type: 'Clean Sheets', count: stat.cleanSheets, points: pts }); }
    }
    const votes = allVotes.filter(v => v.matchId === match.id);
    const voteCounts: Record<string, number> = {};
    votes.forEach(vote => {
      const id = String(vote.votedForId);
      voteCounts[id] = (voteCounts[id] || 0) + 1;
    });
    let motmId: string | null = null;
    let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]) => {
      if (count > maxVotes) {
        motmId = id;
        maxVotes = count;
      }
    });
    if (motmId === userId) { const pts = (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose); matchXP += pts; details.push({ type: 'MOTM', points: pts }); }
    if (voteCounts[userId]) { const pts = (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[userId]; matchXP += pts; details.push({ type: 'MOTM Votes', count: voteCounts[userId], points: pts }); }
    runningTotal += matchXP;
    breakdown.push({
      matchId: match.id,
      matchDate: match.date,
      details,
      matchXP,
      runningTotal
    });
  }
  ctx.body = { userId, leagueId, breakdown };
});

// POST endpoint to reset all users' XP in a league to the correct value
router.post('/:id/reset-xp', required, async (ctx) => {
  const leagueId = ctx.params.id;
  const league = await League.findByPk(leagueId, {
    include: [{ model: User, as: 'members' }]
  });
  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }
  // Get all completed matches in this league
  const matches = await Match.findAll({
    where: { leagueId, status: 'completed' },
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ]
  });
  const matchIds = matches.map(m => m.id);
  const allStats = await MatchStatistics.findAll({ where: { match_id: matchIds } });
  const allVotes = await Vote.findAll({ where: { matchId: matchIds } });
  for (const member of (league as any).members || []) {
    let userXP = 0;
    for (const match of matches) {
      const homeTeamUsers = ((match as any).homeTeamUsers || []);
      const awayTeamUsers = ((match as any).awayTeamUsers || []);
      // Only count the user once per match
      const isOnTeam = [...homeTeamUsers, ...awayTeamUsers].some((u: any) => u.id === member.id);
      if (!isOnTeam) continue;
      const homeGoals = match.homeTeamGoals ?? 0;
      const awayGoals = match.awayTeamGoals ?? 0;
      // Win/Draw/Loss
      let teamResult: 'win' | 'draw' | 'lose' = 'lose';
      const isHome = homeTeamUsers.some((u: any) => u.id === member.id);
      const isAway = awayTeamUsers.some((u: any) => u.id === member.id);
      if (isHome && homeGoals > awayGoals) teamResult = 'win';
      else if (isAway && awayGoals > homeGoals) teamResult = 'win';
      else if (homeGoals === awayGoals) teamResult = 'draw';
      // Only one of these applies:
      if (teamResult === 'win') userXP += xpPointsTable.winningTeam;
      else if (teamResult === 'draw') userXP += xpPointsTable.draw;
      else userXP += xpPointsTable.losingTeam;
      // Get stats for this user in this match (from pre-fetched allStats)
      const stat = allStats.find(s => s.user_id === member.id && s.match_id === match.id);
      if (stat) {
        if (stat.goals) userXP += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
        if (stat.assists) userXP += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
        if (stat.cleanSheets) userXP += xpPointsTable.cleanSheet * stat.cleanSheets;
      }
      // Votes for MOTM (from pre-fetched allVotes)
      const votes = allVotes.filter(v => v.matchId === match.id);
      const voteCounts: Record<string, number> = {};
      votes.forEach(vote => {
        const id = String(vote.votedForId);
        voteCounts[id] = (voteCounts[id] || 0) + 1;
      });
      let motmId: string | null = null;
      let maxVotes = 0;
      Object.entries(voteCounts).forEach(([id, count]) => {
        if (count > maxVotes) {
          motmId = id;
          maxVotes = count;
        }
      });
      if (motmId === member.id) userXP += (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
      if (voteCounts[member.id]) userXP += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[member.id];
    }
    // Update the user's XP in the database
    const user = await User.findByPk(member.id);
    if (user) {
      user.xp = userXP;
      await user.save();
    }
  }
  // Update cache for all users whose XP was reset
  for (const member of (league as any).members || []) {
    const user = await User.findByPk(member.id);
    if (user) {
      const updatedUserData = {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture,
        position: user.position,
        positionType: user.positionType,
        xp: user.xp || 0
      };

      // Update players cache
      cache.updateArray('players_all', updatedUserData);
      
      // Clear any user-specific caches
      cache.clearPattern(`user_leagues_${user.id}`);
    }
  }

  // Clear leaderboard cache for this league
  cache.clearPattern(`leaderboard_`);

  ctx.body = { success: true, message: 'XP reset for all users in this league.' };
});

// Find the main GET /leagues endpoint and wrap with cache logic
router.get('/', async (ctx) => {
  const cacheKey = 'leagues_all';
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }
  // Existing DB fetch logic
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  try {
    const user = await User.findByPk(ctx.state.user.userId, {
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

    const leagues = (user as any).leagues || [];
    cache.set(cacheKey, { success: true, leagues }, 600); // cache for 30 seconds
    ctx.body = { success: true, leagues };
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.throw(500, "Failed to retrieve leagues.");
  }
  // Suppose the result is in variable 'leagues'
  // cache.set(cacheKey, leagues, 30); // cache for 30 seconds
  // ctx.body = leagues;
});

export default router;

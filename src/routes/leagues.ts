import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { getInviteCode, verifyLeagueAdmin } from '../modules/utils';
import type { LeagueAttributes } from '../models/League';
import { transporter } from '../modules/sendEmail';
import { Op, fn, col, where } from 'sequelize';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { upload, uploadToCloudinary } from '../middleware/upload';
const { League, Match, User, MatchGuest } = models;

// Add these helpers below imports
const isMultipart = (ctx: any) =>
  /multipart\/form-data/i.test(String(ctx.request.headers['content-type'] || ''));

const conditionalUpload = (fields: Array<{ name: string; maxCount?: number }>) => {
  const handler = upload.fields(fields);
  return async (ctx: any, next: any) => {
    if (isMultipart(ctx)) {
      // Run multer only for multipart requests
      return (handler as any)(ctx, next);
    }
    return next();
  };
};

// Koa app: remove express types

// UUID validator (for Koa routes)
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

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
    console.log('result', result);

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
  if (!isUuid(ctx.params.id)) {
    ctx.throw(400, "Invalid league id");
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
      },
      {
        model: User,
        as: 'administeredLeagues',
      },
      {
        model: Match,
        as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers' },
          { model: User, as: 'awayTeamUsers' },
          { model: User, as: 'availableUsers' },
          { model: User, as: 'homeCaptain' },
          { model: User, as: 'awayCaptain' },
          { model: MatchGuest, as: 'guestPlayers' } // <-- include guests
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
      image: league.image
    }
  };
});

// Create a new league
router.post("/", required, upload.single('image'), async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const { name, maxGames, showPoints } = ctx.request.body as LeagueAttributes;
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    ctx.throw(400, "League name is required");
  }

  // Case-insensitive duplicate name check
  const existingByName = await League.findOne({
    where: where(fn('LOWER', col('name')), trimmedName.toLowerCase())
  });
  if (existingByName) {
    ctx.status = 409;
    ctx.body = { success: false, message: "A league with this name already exists." };
    return;
  }

  try {
    let imageUrl = null;

    // Handle image upload if file is present
    if (ctx.file) {
      try {
        imageUrl = await uploadToCloudinary(ctx.file.buffer, 'league-images');
        console.log('League image uploaded successfully:', imageUrl);
      } catch (uploadError) {
        console.error('League image upload error:', uploadError);
        // Continue without image
        imageUrl = null;
      }
    }

    const newLeague = await League.create({
      name: trimmedName,
      inviteCode: getInviteCode(),
      maxGames: 20,
      showPoints,
      image: imageUrl,
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
      image: imageUrl,
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
        image: imageUrl,
      },
    };
  } catch (error) {
    console.error('League creation error:', error);
    ctx.throw(500, "Failed to create league");
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
router.post("/:id/matches", required, upload.fields([
  { name: 'homeTeamImage', maxCount: 1 },
  { name: 'awayTeamImage', maxCount: 1 }
]), async (ctx) => {
  // Validate league id before any DB call
  const leagueId = String(ctx.params.id || '').trim();
  if (!isUuid(leagueId)) {
    ctx.throw(400, "Invalid league id");
    return;
  }

  console.log("Body:", ctx.request.body);
  console.log("Files:", ctx.files);
  // Parse FormData fields
  const homeTeamName = ctx.request.body.homeTeamName;
  const awayTeamName = ctx.request.body.awayTeamName;
  const date = ctx.request.body.date;
  const start = ctx.request.body.start;
  const end = ctx.request.body.end;
  const location = ctx.request.body.location;

  // ✅ Validation (only required fields)
  if (!date || !start || !location) {
    ctx.throw(400, "Missing required match details: date, start, or location.");
  }

  // Parse JSON arrays from FormData
  let homeTeamUsers: string[] = [];
  let awayTeamUsers: string[] = [];

  try {
    if (ctx.request.body.homeTeamUsers) {
      homeTeamUsers = JSON.parse(ctx.request.body.homeTeamUsers);
    }
    if (ctx.request.body.awayTeamUsers) {
      awayTeamUsers = JSON.parse(ctx.request.body.awayTeamUsers);
    }
  } catch (error) {
    console.error('Error parsing team users arrays:', error);
  }

  // Filter out guest placeholder IDs that are not valid UUIDs. These placeholders
  // (e.g. "guest-home-<timestamp>-<rand>") should not be inserted into the
  // UserHomeMatches/UserAwayMatches join tables which expect UUID userIds.
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  const rawHomeTeamUsers = homeTeamUsers;
  const rawAwayTeamUsers = awayTeamUsers;
  homeTeamUsers = (homeTeamUsers || []).filter((id: string) => uuidRegex.test(id));
  awayTeamUsers = (awayTeamUsers || []).filter((id: string) => uuidRegex.test(id));

  const guestHomeIds = (rawHomeTeamUsers || []).filter((id: string) => !uuidRegex.test(id));
  const guestAwayIds = (rawAwayTeamUsers || []).filter((id: string) => !uuidRegex.test(id));

  if (guestHomeIds.length || guestAwayIds.length) {
    console.log('Guest placeholders ignored on initial match create (will require separate guest creation route):', { guestHomeIds, guestAwayIds });
  }

  const homeCaptain = ctx.request.body.homeCaptain;
  const awayCaptain = ctx.request.body.awayCaptain;

  await verifyLeagueAdmin(ctx, leagueId)

  const league = await League.findByPk(leagueId, {
    include: [{ model: Match, as: 'matches' }]
  });

  if (!league) {
    ctx.throw(404, "League not found");
    return;
  }

  if (league.maxGames && (league as any).matches.length >= league.maxGames) {
    ctx.throw(403, "This league has reached the maximum number of games.")
  }

  // Handle team image uploads
  let homeTeamImageUrl = null;
  let awayTeamImageUrl = null;

  if (ctx.files) {
    const files = ctx.files as { [fieldname: string]: Express.Multer.File[] };

    // Upload home team image
    if (files.homeTeamImage && files.homeTeamImage[0]) {
      try {
        homeTeamImageUrl = await uploadToCloudinary(files.homeTeamImage[0].buffer, 'team-images');
        console.log('Home team image uploaded successfully:', homeTeamImageUrl);
      } catch (uploadError) {
        console.error('Home team image upload error:', uploadError);
        // Continue without image
        homeTeamImageUrl = null;
      }
    }

    // Upload away team image
    if (files.awayTeamImage && files.awayTeamImage[0]) {
      try {
        awayTeamImageUrl = await uploadToCloudinary(files.awayTeamImage[0].buffer, 'team-images');
        console.log('Away team image uploaded successfully:', awayTeamImageUrl);
      } catch (uploadError) {
        console.error('Away team image upload error:', uploadError);
        // Continue without image
        awayTeamImageUrl = null;
      }
    }
  }


  const matchDate = new Date(date);
  const startDate = new Date(start);
  const finalEndDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 60000);
  const match = await Match.create({
    awayTeamName,
   homeTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'scheduled',
    homeCaptainId: homeCaptain || null, // <-- save captain
    awayCaptainId: awayCaptain || null,  // <-- save captain
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl
  } as any);
  console.log('match create', match)

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

  // Serialize match data to avoid circular references
  const serializedMatch = {
    id: match.id,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    location: match.location,
    leagueId: match.leagueId,
    date: match.date,
    start: match.start,
    end: match.end,
    status: match.status,
    homeCaptainId: match.homeCaptainId,
    awayCaptainId: match.awayCaptainId,
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl,
    homeTeamUsers: (matchWithUsers as any)?.homeTeamUsers?.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      profilePicture: user.profilePicture,
      shirtNumber: user.shirtNumber,
      level: user.level,
      positionType: user.positionType,
      preferredFoot: user.preferredFoot
    })) || [],
    awayTeamUsers: (matchWithUsers as any)?.awayTeamUsers?.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      profilePicture: user.profilePicture,
      shirtNumber: user.shirtNumber,
      level: user.level,
      positionType: user.positionType,
      preferredFoot: user.preferredFoot
    })) || [],
    guests: [] // <-- include empty guests on create
  };

  // Update cache with new match
  const newMatchData = {
    id: match.id,
    homeTeamName,
    awayTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'scheduled',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl,
    homeTeamUsers: serializedMatch.homeTeamUsers,
    awayTeamUsers: serializedMatch.awayTeamUsers,
    guests: [] // <-- cache guests too
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
    match: serializedMatch,
  };
});

// Get a single match's details
router.get("/:leagueId/matches/:matchId", required, async (ctx) => {
  const { matchId } = ctx.params;

  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
      { model: MatchGuest, as: 'guestPlayers' }, // <-- include guests
    ],
  });

  if (!match) { ctx.throw(404, "Match not found"); return; } // <-- return

  // Map guestPlayers -> guests for the client
  const plain = (match as any).toJSON ? (match as any).toJSON() : match;
  const guests = (plain.guestPlayers || []).map((g: any) => ({
    id: g.id,
    team: g.team,
    firstName: g.firstName,
    lastName: g.lastName,
    shirtNumber: g.shirtNumber,
  }));

  ctx.body = { success: true, match: { ...plain, guests } };
});

// Update a match's details
// router.patch("/:leagueId/matches/:matchId", required, async (ctx) => {
//   await verifyLeagueAdmin(ctx, ctx.params.leagueId);

//   const { matchId } = ctx.params;
//   const match = await Match.findByPk(matchId);

//   const {
//     homeTeamName,
//     awayTeamName,
//     date,
//     location,
//     homeTeamUsers,
//     awayTeamUsers,
//     homeCaptainId,
//     awayCaptainId,
//   } = ctx.request.body as {
//     homeTeamName: string;
//     awayTeamName: string;
//     date: string;
//     location: string;
//     homeTeamUsers: string[];
//     awayTeamUsers: string[];
//     homeCaptainId:string;
//     awayCaptainId:string;
//   };

//   const matchDate = new Date(date);

//   if (!match) {
//     ctx.throw(404, "Match not found");
//     return;
//   }

//   await match.update({
//     homeTeamName,
//     awayTeamName,
//     date: matchDate,
//     start: matchDate,
//     end: matchDate,
//     location,
//     homeCaptainId: ctx.request.body.homeCaptainId, // <-- add this
//     awayCaptainId: ctx.request.body.awayCaptainId, // <-- add this
//   });

//   if (homeTeamUsers) {
//     await (match as any).setHomeTeamUsers(homeTeamUsers);
//   }
//   if (awayTeamUsers) {
//     await (match as any).setAwayTeamUsers(awayTeamUsers);
//   }

//   const updatedMatch = await Match.findByPk(matchId, {
//     include: [
//       { model: User, as: 'homeTeamUsers' },
//       { model: User, as: 'awayTeamUsers' },
//     ],
//   });

//   // Update cache with updated match
//   const updatedMatchData = {
//     id: matchId,
//     homeTeamName,
//     awayTeamName,
//     location,
//     leagueId: match.leagueId,
//     date: matchDate,
//     start: matchDate,
//     end: matchDate,
//     status: match.status,
//     homeCaptainId: ctx.request.body.homeCaptainId,
//     awayCaptainId: ctx.request.body.awayCaptainId,
//     homeTeamUsers: (updatedMatch as any)?.homeTeamUsers || [],
//     awayTeamUsers: (updatedMatch as any)?.awayTeamUsers || []
//   };

//   // Update matches cache
//   cache.updateArray('matches_all', updatedMatchData);

//   ctx.body = {
//     success: true,
//     message: "Match updated successfully.",
//     match: updatedMatch,
//   };
// });

router.patch(
  "/:leagueId/matches/:matchId",
  required,
  conditionalUpload([
    { name: 'homeTeamImage', maxCount: 1 },
    { name: 'awayTeamImage', maxCount: 1 }
  ]),
  async (ctx) => {
    await verifyLeagueAdmin(ctx, ctx.params.leagueId);

    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.throw(404, "Match not found");
      return;
    }

    const body = (ctx.request as any).body || {};
    const files = (ctx.files as any) || {};

    const hasProp = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

    const parseIds = (v: any): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed.map(String) : [v];
        } catch {
          return [v];
        }
      }
      return [];
    };

    const parseGuests = (v: any): Array<{ id?: string; team: 'home'|'away'; firstName: string; lastName: string; shirtNumber?: string }> => {
      if (!v) return [];
      try {
        const arr = typeof v === 'string' ? JSON.parse(v) : v;
        return Array.isArray(arr) ? arr.map(g => ({
          id: g.id ? String(g.id) : undefined,
          team: g.team === 'away' ? 'away' : 'home',
          firstName: String(g.firstName || '').trim(),
          lastName: String(g.lastName || '').trim(),
          shirtNumber: g.shirtNumber != null ? String(g.shirtNumber) : undefined,
        })) : [];
      } catch {
        return [];
      }
    };

    const homeTeamName = body.homeTeamName;
    const awayTeamName = body.awayTeamName;
    const date = body.date;
    const location = body.location;

    const homeTeamUsers = parseIds(body.homeTeamUsers);
    const awayTeamUsers = parseIds(body.awayTeamUsers);

    const homeCaptainId = body.homeCaptainId || null;
    const awayCaptainId = body.awayCaptainId || null;

    let homeTeamImageUrl = match.homeTeamImage;
    let awayTeamImageUrl = match.awayTeamImage;

    if (files.homeTeamImage?.[0]?.buffer) {
      try {
        homeTeamImageUrl = await uploadToCloudinary(files.homeTeamImage[0].buffer, 'team-images');
      } catch (e) {
        console.error('Home team image upload error:', e);
      }
    }
    if (files.awayTeamImage?.[0]?.buffer) {
      try {
        awayTeamImageUrl = await uploadToCloudinary(files.awayTeamImage[0].buffer, 'team-images');
      } catch (e) {
        console.error('Away team image upload error:', e);
      }
    }

    const matchDate = date ? new Date(date) : match.date;

    await match.update({
      homeTeamName,
      awayTeamName,
      date: matchDate,
      start: matchDate,
      end: matchDate,
      location,
      homeCaptainId,
      awayCaptainId,
      homeTeamImage: homeTeamImageUrl,
      awayTeamImage: awayTeamImageUrl
    });

    // Always set associations if field was sent (even if empty) so clearing works
    if (hasProp(body, 'homeTeamUsers')) {
      await (match as any).setHomeTeamUsers(homeTeamUsers);
    }
    if (hasProp(body, 'awayTeamUsers')) {
      await (match as any).setAwayTeamUsers(awayTeamUsers);
    }

    // Guests sync (client sends in PATCH, see edit page)
    // Prefer combined 'guests', else merge 'homeGuests' + 'awayGuests'
    let desiredGuests = parseGuests(body.guests);
    if (!desiredGuests.length) {
      const homeGuests = parseGuests(body.homeGuests).map(g => ({ ...g, team: 'home' as const }));
      const awayGuests = parseGuests(body.awayGuests).map(g => ({ ...g, team: 'away' as const }));
      desiredGuests = [...homeGuests, ...awayGuests];
    }

    if (desiredGuests.length || hasProp(body, 'guests') || hasProp(body, 'homeGuests') || hasProp(body, 'awayGuests')) {
      const existing = await MatchGuest.findAll({ where: { matchId } });
      const existingMap = new Map(existing.map((g: any) => [String(g.id), g]));

      // Delete removed
      const keepIds = new Set(desiredGuests.filter(g => g.id).map(g => String(g.id)));
      const toDeleteIds = existing
        .map((g: any) => String(g.id))
        .filter(id => !keepIds.has(id));
      if (toDeleteIds.length) {
        await MatchGuest.destroy({ where: { matchId, id: toDeleteIds } as any });
      }

      // Upsert
      for (const g of desiredGuests) {
        if (g.id && existingMap.has(g.id)) {
          await MatchGuest.update(
            { team: g.team, firstName: g.firstName, lastName: g.lastName},
            { where: { id: g.id, matchId } as any }
          );
        } else {
          await MatchGuest.create({
            matchId,
            team: g.team,
            firstName: g.firstName,
            lastName: g.lastName,
            shirtNumber: g.shirtNumber ?? null
          } as any);
        }
      }
    }

    const updatedMatch = await Match.findByPk(matchId, {
      include: [
        { model: User, as: 'homeTeamUsers' },
        { model: User, as: 'awayTeamUsers' },
        { model: MatchGuest, as: 'guestPlayers' },
      ],
    });

    const guests = (updatedMatch as any)?.guestPlayers?.map((g: any) => ({
      id: g.id,
      team: g.team,
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber,
    })) || [];

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
      homeCaptainId,
      awayCaptainId,
      homeTeamImage: homeTeamImageUrl,
      awayTeamImage: awayTeamImageUrl,
      homeTeamUsers: (updatedMatch as any)?.homeTeamUsers?.map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: user.profilePicture,
        shirtNumber: user.shirtNumber,
        level: user.level,
        positionType: user.positionType,
        preferredFoot: user.preferredFoot
      })) || [],
      awayTeamUsers: (updatedMatch as any)?.awayTeamUsers?.map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: user.profilePicture,
        shirtNumber: user.shirtNumber,
        level: user.level,
        positionType: user.positionType,
        preferredFoot: user.preferredFoot
      })) || [],
      guests
    };

    cache.updateArray('matches_all', updatedMatchData);
    const league = await League.findByPk(match.leagueId, {
      include: [{ model: User, as: 'members' }]
    });
    if (league) {
      const memberIds = (league as any)?.members?.map((m: any) => m.id) || [];
      memberIds.forEach((memberId: string) => {
        cache.updateArray(`user_leagues_${memberId}`, updatedMatchData);
      });
    }

    ctx.body = { success: true, message: "Match updated successfully.", match: updatedMatchData };
  }
);

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

// List guests for a match
router.get('/:leagueId/matches/:matchId/guests', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; } // <-- return

  const guests = await MatchGuest.findAll({ where: { matchId } });
  ctx.body = { success: true, guests };
});

// Add a guest player to a match (ADMIN ONLY)
router.post('/:leagueId/matches/:matchId/guests', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, firstName, lastName, shirtNumber } = (ctx.request as any).body || {};

  await verifyLeagueAdmin(ctx, leagueId); // <-- admin check

  if (!team || !['home', 'away'].includes(team)) { ctx.throw(400, 'Invalid team'); return; }
  if (!firstName || !lastName) { ctx.throw(400, 'First and last name required'); return; }

  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; }

  const guest = await MatchGuest.create({
    matchId,
    team,
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    shirtNumber: shirtNumber ? String(shirtNumber) : undefined, // <-- undefined, not null
  });

  // Fetch all guests and update caches so lists stay fresh
  const allGuests = await MatchGuest.findAll({ where: { matchId } });
  const guests = allGuests.map((g: any) => ({
    id: g.id,
    team: g.team,
    firstName: g.firstName,
    lastName: g.lastName,
    shirtNumber: g.shirtNumber,
  }));

  // Update matches cache
  cache.updateArray('matches_all', { id: matchId, guests });

  // Update league caches for all members
  const leagueWithMembers = await League.findByPk(leagueId, { include: [{ model: User, as: 'members' }] });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, { id: matchId, guests });
  });

  ctx.body = { success: true, guest, guests };
});

// Remove a guest player from a match (ADMIN ONLY)
router.delete('/:leagueId/matches/:matchId/guests/:guestId', required, async (ctx) => {
  const { leagueId, matchId, guestId } = ctx.params;

  await verifyLeagueAdmin(ctx, leagueId); // <-- admin check

  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; }

  const guest = await MatchGuest.findOne({ where: { id: guestId, matchId } });
  if (!guest) { ctx.throw(404, 'Guest not found'); return; }

  await guest.destroy();
  ctx.body = { success: true, message: 'Guest removed' };
});

export default router;

import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { MatchAvailability } from '../models/MatchAvailability';
import  Notification  from '../models/Notification';
import { getInviteCode, verifyLeagueAdmin } from '../modules/utils';
import type { LeagueAttributes } from '../models/League';
import { transporter } from '../modules/sendEmail';
import { Op, fn, col, where, QueryTypes } from 'sequelize';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { upload, uploadToCloudinary } from '../middleware/upload';
import { MatchPlayerLayout } from '../models';
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

// Helper to return a consistent JSON 404 instead of throwing
function respondLeagueNotFound(ctx: any) {
  ctx.status = 404;
  ctx.body = { success: false, message: 'League not found' };
}

// REMOVE this incorrect route block (prefix already includes /leagues)
// router.get('/leagues/:leagueId', required, async (ctx) => { ... });

// ✅ Keep the canonical league-by-id route and return JSON instead of throwing
router.get("/:id", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }
  if (!isUuid(ctx.params.id)) {
    ctx.status = 400;
    ctx.body = { success: false, message: "Invalid league id" };
    return;
  }

  const leagueId = ctx.params.id;

  try {
    await Match.update(
      { status: 'RESULT_PUBLISHED' },
      {
        where: {
          leagueId: leagueId,
          status: 'SCHEDULED',
          end: { [Op.lt]: new Date() }
        }
      }
    );
  } catch (error) {
    console.error('Error auto-updating match statuses:', error);
  }

  const league = await League.findByPk(ctx.params.id, {
    include: [
      { model: User, as: 'members' },
      { model: User, as: 'administeredLeagues' },
      {
        model: Match,
        as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers' },
          { model: User, as: 'awayTeamUsers' },
          { model: User, as: 'homeCaptain' },
          { model: User, as: 'awayCaptain' },
          { model: MatchGuest, as: 'guestPlayers' },
          { model: User, as: 'availableUsers' }
        ]
      }
    ]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  const isMember = (league as any).members?.some((member: any) => member.id === ctx.state.user!.userId);
  const isAdmin = (league as any).administeredLeagues?.some((admin: any) => admin.id === ctx.state.user!.userId);

  if (!isMember && !isAdmin) {
    // Optional stricter access: keep as 403 JSON instead of throw
    ctx.status = 403;
    ctx.body = { success: false, message: "You don't have access to this league" };
    return;
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

// ✅ ADD AVAILABILITY ROUTE HERE
router.get('/:leagueId/matches/:matchId/availability', required, async (ctx) => {
  try {
    const { leagueId, matchId } = ctx.params;
    
    console.log(`🔍 Fetching availability for match ${matchId} in league ${leagueId}`);

    // Validate parameters
    if (!isUuid(leagueId) || !isUuid(matchId)) {
      ctx.throw(400, 'Invalid league or match ID');
      return;
    }

    // Verify match exists in this league
    const match = await Match.findOne({
      where: { 
        id: matchId, 
        leagueId: leagueId 
      }
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    // Get all availability records for this match
    const availability = await MatchAvailability.findAll({
      where: { match_id: matchId },
      attributes: ['user_id', 'status', 'created_at', 'updated_at'],
      order: [['created_at', 'ASC']]
    });

    console.log(`📊 Found ${availability.length} availability records for match ${matchId}`);

    // Format the response to match what the frontend expects
    const formattedAvailability = availability.map((record: any) => ({
      userId: record.user_id,
      status: record.status,
      createdAt: record.created_at,
      updatedAt: record.updated_at
    }));

    ctx.body = {
      success: true,
      availability: formattedAvailability,
      matchId,
      count: formattedAvailability.length
    };

    console.log(`✅ Successfully returned availability data for match ${matchId}`);

  } catch (error) {
    console.error('❌ Error fetching match availability:', error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to fetch availability data',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Get all leagues for the current user (for /leagues/user) - ULTRA FAST FIXED
router.get('/user', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `user_leagues_${userId}_ultra_fast`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    // Try to get user leagues with simple fallback
    let results;
    
    try {
      // First try with minimal fields that should exist
      [results] = await User.sequelize?.query(`
        SELECT l.id, l.name, l."maxGames", l.image, l."createdAt"
        FROM "Leagues" l
        INNER JOIN "LeagueMembers" lm ON l.id = lm."leagueId"
        WHERE lm."userId" = :userId
        ORDER BY l."createdAt" DESC
        LIMIT 15
      `, {
        replacements: { userId },
        type: QueryTypes.SELECT
      }) || [];
      
      // Add missing fields that frontend expects
      results = (results as any[]).map((league: any) => ({
        ...league,
        description: '', // Add empty description
        type: 'standard', // Add default type
        leagueImage: league.image || null // Map image to leagueImage
      }));
      
    } catch (queryError) {
      console.log('Raw query failed, using fallback:', queryError);
      // Fallback: get all leagues (not ideal but works)
      const allLeagues = await League.findAll({
        attributes: ['id', 'name', 'maxGames', 'image', 'createdAt'],
        limit: 15
      });
      
      // Map to expected format
      results = allLeagues.map((league: any) => ({
        id: league.id,
        name: league.name,
        description: '', // Add empty description
        type: 'standard', // Add default type
        maxGames: league.maxGames,
        leagueImage: league.image || null,
        createdAt: league.createdAt
      }));
    }

    const result = { 
      success: true, 
      leagues: results || []
    };

    console.log('User leagues result:', result);

    cache.set(cacheKey, result, 1800); // 30 min cache
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.status = 500;
    ctx.body = { 
      success: false, 
      message: "Failed to retrieve leagues.",
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Get all leagues for the current user - ULTRA FAST FIXED (keep this at "/")
router.get("/", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `leagues_main_${userId}_ultra_fast`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    // Try to get user leagues with simple fallback
    let results;
    
    try {
      // First try with minimal fields that should exist
      [results] = await User.sequelize?.query(`
        SELECT l.id, l.name, l."maxGames", l.image, l."createdAt"
        FROM "Leagues" l
        INNER JOIN "LeagueMembers" lm ON l.id = lm."leagueId"
        WHERE lm."userId" = :userId
        ORDER BY l."createdAt" DESC
        LIMIT 10
      `, {
        replacements: { userId },
        type: QueryTypes.SELECT
      }) || [];
      
      // Add missing fields that frontend expects
      results = (results as any[]).map((league: any) => ({
        ...league,
        description: '', // Add empty description
        type: 'standard', // Add default type
        leagueImage: league.image || null // Map image to leagueImage
      }));
      
    } catch (queryError) {
      console.log('Raw query failed, using fallback:', queryError);
      // Fallback: get all leagues (not ideal but works)
      const allLeagues = await League.findAll({
        attributes: ['id', 'name', 'maxGames', 'image', 'createdAt'],
        limit: 10
      });
      
      // Map to expected format
      results = allLeagues.map((league: any) => ({
        id: league.id,
        name: league.name,
        description: '', // Add empty description
        type: 'standard', // Add default type
        maxGames: league.maxGames,
        leagueImage: league.image || null,
        createdAt: league.createdAt
      }));
    }

    const result = { 
      success: true, 
      leagues: results || [] 
    };
    
    cache.set(cacheKey, result, 1800); // 30 min cache
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.status = 500;
    ctx.body = { 
      success: false, 
      message: "Failed to retrieve leagues.",
      error: error instanceof Error ? error.message : 'Unknown error'
    };
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
      { status: 'RESULT_PUBLISHED' },
      {
        where: {
          leagueId: leagueId,
          status: 'SCHEDULED',
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
          // { model: User, as: 'availableUsers' },
          { model: User, as: 'homeCaptain' },
          { model: User, as: 'awayCaptain' },
          { model: MatchGuest, as: 'guestPlayers' }, // <-- include guests
           { model: User, as: 'availableUsers' }
        ]
      }
    ]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
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

      if (user.email) {
        await transporter.sendMail({
          to: user.email,
          subject: `You've created a new league: ${newLeague.name}`,
          html: emailHtml,
        });
        console.log(`Creation email sent to ${user.email}`);
      } else {
        console.warn('Email not sent: user has no email');
      }
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
    return respondLeagueNotFound(ctx);
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
    return respondLeagueNotFound(ctx);
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
    return respondLeagueNotFound(ctx);
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

// Create a new match in a league WITH NOTIFICATIONS
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

  console.log("🎯 Creating match with notifications...");
  
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

  // Filter out guest placeholder IDs that are not valid UUIDs
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  const rawHomeTeamUsers = homeTeamUsers;
  const rawAwayTeamUsers = awayTeamUsers;
  homeTeamUsers = (homeTeamUsers || []).filter((id: string) => uuidRegex.test(id));
  awayTeamUsers = (awayTeamUsers || []).filter((id: string) => uuidRegex.test(id));

  const guestHomeIds = (rawHomeTeamUsers || []).filter((id: string) => !uuidRegex.test(id));
  const guestAwayIds = (rawAwayTeamUsers || []).filter((id: string) => !uuidRegex.test(id));

  if (guestHomeIds.length || guestAwayIds.length) {
    console.log('Guest placeholders ignored on initial match create:', { guestHomeIds, guestAwayIds });
  }

  const homeCaptain = ctx.request.body.homeCaptain;
  const awayCaptain = ctx.request.body.awayCaptain;

  await verifyLeagueAdmin(ctx, leagueId);

  // 🔥 UPDATED: Include members in the league query
  const league = await League.findByPk(leagueId, {
    include: [
      { model: Match, as: 'matches' },
      { model: User, as: 'members' } // <-- ADD THIS FOR NOTIFICATIONS
    ]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  if (league.maxGames && (league as any).matches.length >= league.maxGames) {
    ctx.throw(403, "This league has reached the maximum number of games.");
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
        awayTeamImageUrl = null;
      }
    }
  }

  const matchDate = new Date(date);
  const startDate = new Date(start);
  const finalEndDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 60000);
  
  // CREATE THE MATCH
  const match = await Match.create({
    awayTeamName,
    homeTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl
  } as any);

  console.log('✅ Match created:', match.id);

  // Add team users
  if (homeTeamUsers.length > 0) {
    await (match as any).addHomeTeamUsers(homeTeamUsers);
  }

  if (awayTeamUsers.length > 0) {
    await (match as any).addAwayTeamUsers(awayTeamUsers);
  }

  // 🔥 CREATE NOTIFICATIONS FOR ALL LEAGUE MEMBERS
  const members = (league as any).members || [];
  console.log(`📧 Creating notifications for ${members.length} league members`);

  if (members.length > 0) {
    try {
      const memberIds = members.map((m: any) => m.id);

      // Create availability entries
      const availabilityEntries = memberIds.map((userId: string) => ({
        match_id: match.id,
        user_id: userId,
        status: 'pending' as const
      }));

      await MatchAvailability.bulkCreate(availabilityEntries);
      console.log(`✅ Created ${availabilityEntries.length} availability entries`);

      // Create notifications
      const matchDateFormatted = new Date(start).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const notificationEntries = memberIds.map((userId: string) => ({
        user_id: userId,
        type: 'match_created',
        title: '⚽ New Match Scheduled!',
        body: `${homeTeamName} vs ${awayTeamName} on ${matchDateFormatted} at ${location}. Please update your availability.`,
        meta: JSON.stringify({
          matchId: match.id,
          leagueId: leagueId,
          homeTeam: homeTeamName,
          awayTeam: awayTeamName,
          matchStart: start,
          location: location
        }),
        read: false,
        created_at: new Date(),
        updated_at: new Date()
      }));

      await Notification.bulkCreate(notificationEntries);
      console.log(`🔔 Created ${notificationEntries.length} notifications`);

    } catch (notificationError) {
      console.error('❌ Error creating notifications:', notificationError);
    }
  }

  // Get the complete match with users for response
  const matchWithUsers = await Match.findByPk(match.id, {
    include: [
      { model: User, as: 'awayTeamUsers' },
      { model: User, as: 'homeTeamUsers' }
    ]
  });

  // Serialize match data to avoid circular references
  const serializedMatch = {
    id: match.id,
    homeTeamName,
    awayTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
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
    guests: []
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
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl,
    homeTeamUsers: serializedMatch.homeTeamUsers,
    awayTeamUsers: serializedMatch.awayTeamUsers,
    guests: []
  };

  // Update matches cache
  cache.updateArray('matches_all', newMatchData);

  // Update league cache with new match
  const updatedLeagueData = {
    id: leagueId,
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
  const memberIds = members.map((m: any) => m.id);
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.status = 201;
  ctx.body = {
    success: true,
    message: `Match scheduled successfully! ${members.length} members notified.`,
    match: serializedMatch,
    notificationsSent: members.length
  };
});

// Get a single match's details
router.get("/:leagueId/matches/:matchId", required, async (ctx) => {
  const { matchId } = ctx.params;

  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
      { model: MatchGuest, as: 'guestPlayers' },
    ],
  });

  if (!match) { 
    ctx.status = 404;
    ctx.body = { success: false, message: "Match not found" };
    return;
  }

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
    if (!match) { ctx.throw(404, "Match not found"); return; }

    const body = (ctx.request as any).body || {};
    const files = (ctx.files as any) || {};

    const hasProp = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

    const parseIds = (v: any): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.map(String) : [v]; }
        catch { return [v]; }
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
    const date = body.date;    // optional
    const startIso = body.start; // optional
    const endIso = body.end;     // optional
    const location = body.location; // optional

    const homeTeamUsers = parseIds(body.homeTeamUsers);
    const awayTeamUsers = parseIds(body.awayTeamUsers);

    // Accept either ...Id or plain keys from FormData (only persist with >=6 players)
    const homeCaptainIdRaw = (body.homeCaptain ?? body.homeCaptainId);
    const awayCaptainIdRaw = (body.awayCaptain ?? body.awayCaptainId);

    // Upload images if provided
    let homeTeamImageUrl = match.homeTeamImage;
    let awayTeamImageUrl = match.awayTeamImage;
    if (files.homeTeamImage?.[0]?.buffer) {
      try { homeTeamImageUrl = await uploadToCloudinary(files.homeTeamImage[0].buffer, 'team-images'); }
      catch (e) { console.error('Home team image upload error:', e); }
    }
    if (files.awayTeamImage?.[0]?.buffer) {
      try { awayTeamImageUrl = await uploadToCloudinary(files.awayTeamImage[0].buffer, 'team-images'); }
      catch (e) { console.error('Away team image upload error:', e); }
    }

    // Compute start/end but do not require inputs
    const previousStart = match.start;
    const previousEnd = match.end;
    const prevDurationMs = previousEnd && previousStart
      ? (new Date(previousEnd).getTime() - new Date(previousStart).getTime())
      : 90 * 60 * 1000;

    const computedStart = startIso
      ? new Date(startIso)
      : (date ? new Date(date) : new Date(previousStart));
    const computedEnd = endIso
      ? new Date(endIso)
      : (date ? new Date(new Date(date).getTime() + prevDurationMs) : new Date(new Date(computedStart).getTime() + prevDurationMs));
    const matchDate = computedStart;

    // Only update provided primitives; avoid overwriting non-sent fields
    const updatePayload: any = {};
    if (hasProp(body, 'homeTeamName')) updatePayload.homeTeamName = homeTeamName;
    if (hasProp(body, 'awayTeamName')) updatePayload.awayTeamName = awayTeamName;
    if (hasProp(body, 'location')) updatePayload.location = location;
    // Update timing if any timing field present
    if (hasProp(body, 'date') || hasProp(body, 'start') || hasProp(body, 'end')) {
      updatePayload.date = matchDate;
      updatePayload.start = computedStart;
      updatePayload.end = computedEnd;
    }
    // Always allow image updates if uploaded
    updatePayload.homeTeamImage = homeTeamImageUrl;
    updatePayload.awayTeamImage = awayTeamImageUrl;

    if (Object.keys(updatePayload).length) {
      await match.update(updatePayload);
    }

    // Detect actual team changes (only if arrays were sent)
    const currHome = await (match as any).getHomeTeamUsers({ attributes: ['id'] });
    const currAway = await (match as any).getAwayTeamUsers({ attributes: ['id'] });
    const currHomeIds = currHome.map((u: any) => String(u.id));
    const currAwayIds = currAway.map((u: any) => String(u.id));
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

    const teamsWereSent = hasProp(body, 'homeTeamUsers') || hasProp(body, 'awayTeamUsers');
    const teamsChanged = teamsWereSent && (!sameSet(homeTeamUsers, currHomeIds) || !sameSet(awayTeamUsers, currAwayIds));

    // Guests sync (only when provided)
    let desiredGuests = parseGuests(body.guests);
    if (!desiredGuests.length) {
      const homeGuests = parseGuests(body.homeGuests).map(g => ({ ...g, team: 'home' as const }));
      const awayGuests = parseGuests(body.awayGuests).map(g => ({ ...g, team: 'away' as const }));
      desiredGuests = [...homeGuests, ...awayGuests];
    }
    if (desiredGuests.length || hasProp(body, 'guests') || hasProp(body, 'homeGuests') || hasProp(body, 'awayGuests')) {
      const existing = await MatchGuest.findAll({ where: { matchId } });
      const existingMap = new Map(existing.map((g: any) => [String(g.id), g]));

      const keepIds = new Set(desiredGuests.filter(g => g.id).map(g => String(g.id)));
      const toDeleteIds = existing.map((g: any) => String(g.id)).filter(id => !keepIds.has(id));
      if (toDeleteIds.length) {
        await MatchGuest.destroy({ where: { matchId, id: toDeleteIds } as any });
      }

      for (const g of desiredGuests) {
        if (g.id && existingMap.has(g.id)) {
          await MatchGuest.update(
            { team: g.team, firstName: g.firstName, lastName: g.lastName },
            { where: { id: g.id, matchId } as any }
          );
        } else {
          await MatchGuest.create({
            matchId,
            team: g.team,
            firstName: g.firstName,
            lastName: g.lastName,
            // TS: prefer undefined over null for optional attrs
            shirtNumber: g.shirtNumber ?? undefined
          } as any);
        }
      }
    }

    // Selection logic
    const MIN_PLAYERS = 6;
    const selectedUserIds = Array.from(new Set([...(homeTeamUsers || []), ...(awayTeamUsers || [])]));
    const registeredCount = selectedUserIds.length;
    const guestCount = (desiredGuests || []).length;
    const totalWithGuests = registeredCount + guestCount;

    // Persist teams/captains ONLY if teams changed AND enough players (including guests)
    if (teamsChanged && totalWithGuests >= MIN_PLAYERS) {
      await (match as any).setHomeTeamUsers(homeTeamUsers);
      await (match as any).setAwayTeamUsers(awayTeamUsers);

      // --- AUTO CAPTAIN ASSIGNMENT WITH 3-GAME GAP RULE ---
      const homeCandidates: string[] = homeTeamUsers || [];
      const awayCandidates: string[] = awayTeamUsers || [];
      const refDate: Date = computedStart instanceof Date ? computedStart : new Date(computedStart || match.start || Date.now());

      const prevMatches = await Match.findAll({
        where: { leagueId: match.leagueId, id: { [Op.ne]: matchId }, start: { [Op.lt]: refDate } },
        attributes: ['id', 'homeCaptainId', 'awayCaptainId', 'start'],
        order: [['start', 'DESC']],
        limit: 3
      });

      const ineligible = new Set<string>();
      for (const m of prevMatches) {
        const hc = (m as any).homeCaptainId ? String((m as any).homeCaptainId) : null;
        const ac = (m as any).awayCaptainId ? String((m as any).awayCaptainId) : null;
        if (hc) ineligible.add(hc);
        if (ac) ineligible.add(ac);
      }

      const pickCaptain = (teamIds: string[], preferredRaw?: any): string | null => {
        const preferred = preferredRaw ? String(preferredRaw) : undefined;
        const inTeam = (id: string | undefined) => !!id && teamIds.includes(id);
        if (preferred && inTeam(preferred) && !ineligible.has(preferred)) return preferred;
        const eligible = teamIds.filter((id) => !ineligible.has(String(id)));
        if (eligible.length > 0) return eligible[0];
        return teamIds[0] || null;
      };

      const newHomeCaptainId = pickCaptain(homeCandidates, body.homeCaptain ?? body.homeCaptainId);
      const newAwayCaptainId = pickCaptain(awayCandidates, body.awayCaptain ?? body.awayCaptainId);

      await match.update({
        homeCaptainId: newHomeCaptainId || '',
        awayCaptainId: newAwayCaptainId || ''
      });
      // --- END AUTO CAPTAIN ASSIGNMENT ---

      // --- NEW: NOTIFY NEWLY ADDED PLAYERS ---
      try {
        // Compare with current team membership captured earlier
        const addedHomeIds = (homeTeamUsers || []).filter(id => !currHomeIds.includes(String(id)));
        const addedAwayIds = (awayTeamUsers || []).filter(id => !currAwayIds.includes(String(id)));
        const addedAll = [
          ...addedHomeIds.map(id => ({ id, team: 'home' as const })),
          ...addedAwayIds.map(id => ({ id, team: 'away' as const }))
        ];

        if (addedAll.length > 0) {
          const leagueRec = await League.findByPk(match.leagueId, { attributes: ['id', 'name'] });
          const leagueName = leagueRec ? (leagueRec as any).name : String(match.leagueId);
          const matchStartISO = (computedStart instanceof Date ? computedStart : new Date(computedStart)).toISOString();

          const title = 'You were added to a match';
          const bodyTemplate = (team: 'home' | 'away') =>
            `You have been added to the ${team} team for ${homeTeamName || match.homeTeamName} vs ${awayTeamName || match.awayTeamName} in league ${leagueName}.`;

          const notificationEntries = addedAll.map(({ id, team }) => ({
            user_id: id,
            type: 'match_added_to_team',
            title,
            body: bodyTemplate(team),
            meta: JSON.stringify({
              matchId,
              leagueId: String(match.leagueId),
              team,
              matchStart: matchStartISO,
              location: hasProp(body, 'location') ? location : match.location
            }),
            read: false,
            created_at: new Date(),
            updated_at: new Date()
          }));

          await Notification.bulkCreate(notificationEntries);
          console.log(`🔔 Sent "added to match" notifications to ${notificationEntries.length} users for match ${matchId}`);
        }
      } catch (notifyAddedErr) {
        console.error('Notify (added to match) error:', notifyAddedErr);
      }
      // --- END NEW: NOTIFY NEWLY ADDED PLAYERS ---
    }

    // Notify only when teams actually changed and total (including guests) < 6
    try {
      if (teamsChanged && registeredCount > 0 && totalWithGuests < MIN_PLAYERS) {
        const missing = MIN_PLAYERS - totalWithGuests;
        const title = '⚠️ Match needs more players';
        const bodyText = `${homeTeamName || match.homeTeamName} vs ${awayTeamName || match.awayTeamName} needs ${missing} more player${missing === 1 ? '' : 's'} to confirm.`;
        const matchStartISO = (computedStart instanceof Date ? computedStart : new Date(computedStart)).toISOString();

        const notificationEntries = selectedUserIds.map((userId: string) => ({
          user_id: userId,
          type: 'match_needs_players',
          title,
          body: bodyText,
          meta: JSON.stringify({
            matchId,
            leagueId: String(match.leagueId),
            required: MIN_PLAYERS,
            selectedCount: totalWithGuests,
            matchStart: matchStartISO,
            location: hasProp(body, 'location') ? location : match.location
          }),
          read: false,
          created_at: new Date(),
          updated_at: new Date()
        }));

        await Notification.bulkCreate(notificationEntries);
        console.log(`🔔 Sent "< ${MIN_PLAYERS}" notifications to ${notificationEntries.length} selected players for match ${matchId}`);
      }
    } catch (notifyErr) {
      console.error('Notify (<6 players) error:', notifyErr);
    }

    // Reload and respond using DB values (avoid undefined from request)
    const updatedMatch = await Match.findByPk(matchId, {
      include: [
        { model: User, as: 'homeTeamUsers' },
        { model: User, as: 'awayTeamUsers' },
        { model: MatchGuest, as: 'guestPlayers' },
      ],
    });

    if (!updatedMatch) { ctx.throw(404, "Match not found after update"); return; }

    const guests = (updatedMatch as any)?.guestPlayers?.map((g: any) => ({
      id: g.id,
      team: g.team,
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber,
    })) || [];

    const updatedMatchData = {
      id: updatedMatch.id,
      homeTeamName: (updatedMatch as any).homeTeamName,
      awayTeamName: (updatedMatch as any).awayTeamName,
      location: (updatedMatch as any).location,
      leagueId: (updatedMatch as any).leagueId,
      date: (updatedMatch as any).date,
      start: (updatedMatch as any).start,
      end: (updatedMatch as any).end,
      status: (updatedMatch as any).status,
      homeCaptainId: (updatedMatch as any).homeCaptainId,
      awayCaptainId: (updatedMatch as any).awayCaptainId,
      homeTeamImage: (updatedMatch as any).homeTeamImage,
      awayTeamImage: (updatedMatch as any).awayTeamImage,
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

    // Cache updates
    cache.updateArray('matches_all', updatedMatchData);
    const league = await League.findByPk((updatedMatch as any).leagueId, { include: [{ model: User, as: 'members' }] });
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

  if (user.email) {
    await transporter.sendMail({
      to: user.email,
      subject: `Welcome to ${league.name}`,
      html: emailHtml,
    });
    console.log(`Join email sent to ${user.email}`);
  } else {
    console.warn('Email not sent: user has no email');
  }

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
    return respondLeagueNotFound(ctx);
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
    return respondLeagueNotFound(ctx);
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
    return respondLeagueNotFound(ctx);
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
    const stats = await models.MatchStatistics.findAll({
      where: { user_id: member.id },
      include: [{
        model: models.Match,
        as: 'match',
        where: { leagueId, status: 'RESULT_PUBLISHED' }
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
    where: { leagueId, status: 'RESULT_PUBLISHED' },
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
    where: { leagueId, status: 'RESULT_PUBLISHED' },
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

// Get ALL available leagues (avoid route collision)
// CHANGE path from "/" to "/all"
router.get('/all', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }
  try {
    console.log('Fetching ALL available leagues...');
    const allLeagues = await League.findAll({
      include: [
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'email', 'shirtNumber'] },
        { model: User, as: 'administrators', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Match, as: 'matches', attributes: ['id', 'homeScore', 'awayScore', 'status', 'matchDate'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    const formattedLeagues = allLeagues.map((league: any) => ({
      id: league.id,
      name: league.name,
      description: league.description || '',
      image: league.image,
      inviteCode: league.inviteCode,
      createdAt: league.createdAt,
      maxGames: league.maxGames,
      showPoints: league.showPoints,
      active: league.active,
      members: league.members || [],
      administrators: league.administrators || [],
      matches: league.matches || [],
      adminId: league.administrators?.[0]?.id || null
    }));
    console.log(`Found ${formattedLeagues.length} leagues total`);
    ctx.body = { success: true, leagues: formattedLeagues };
  } catch (error) {
    console.error("Error fetching all leagues:", error);
    ctx.status = 500;
    ctx.body = { success: false, message: "Failed to retrieve leagues" };
  }
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

// CREATE MATCH WITH AUTO NOTIFICATIONS
router.post('/:leagueId/matches', required, async (ctx) => {
  const { leagueId } = ctx.params;
  const { 
    homeTeamName, 
    awayTeamName, 
    start, 
    end, 
    location, 
    date 
  } = ctx.request.body as any;

  try {
    // 1. Create the match - FIX THE END DATE ISSUE
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 60000); // Default 90 minutes
    
    const match = await Match.create({
      leagueId,
      homeTeamName,
      awayTeamName,
      start: startDate,
      end: endDate, // ✅ Now guaranteed to be a Date, not null
      location,
      date: date ? new Date(date) : startDate,
      status: 'SCHEDULED'
    });

    // 2. Get ALL league members using raw query to avoid association issues
    const members = await User.findAll({
      include: [{
        model: League,
        where: { id: leagueId },
        through: { attributes: [] } // Don't include junction table data
      }],
      attributes: ['id', 'username', 'firstName', 'lastName']
    });

    console.log(`Found ${members.length} league members`);

    if (members.length === 0) {
      ctx.body = { success: true, match, message: 'Match created but no members found' };
      return;
    }

    const memberIds = members.map((m: any) => m.id);

    // 3. Create availability entries for all members
    const availabilityEntries = memberIds.map((userId: string) => ({
      match_id: match.id,
      user_id: userId,
      status: 'pending' as const
    }));

    await MatchAvailability.bulkCreate(availabilityEntries);

    // 4. Send notifications to ALL members
    const matchDate = new Date(start).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short', 
      day: 'numeric'
    });

    const notificationEntries = memberIds.map((userId: string) => ({
      user_id: userId,
      type: 'match_availability',
      title: '⚽ New Match Created!',
      body: `${homeTeamName} vs ${awayTeamName} on ${matchDate}. Please update your availability status.`,
      meta: JSON.stringify({ // ✅ Stringify the meta object
        matchId: match.id,
        leagueId: leagueId,
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        matchStart: start
      }),
      read: false,
      created_at: new Date(),
      updated_at: new Date()
    }));

    await Notification.bulkCreate(notificationEntries);

    console.log(`✅ Match created with ${memberIds.length} availability entries and notifications sent`);

    ctx.body = {
      success: true,
      match,
      availabilitiesCreated: memberIds.length,
      notificationsSent: memberIds.length,
      message: `Match created! ${memberIds.length} members notified.`
    };

  } catch (error) {
    console.error('Error creating match with notifications:', error);
    ctx.throw(500, 'Failed to create match');
   }
});

// Team view for a match (used by "view team" dialog)
router.get("/:leagueId/matches/:matchId/team-view", required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;

  const match = await Match.findByPk(matchId, {
    attributes: [
      'id','leagueId','homeTeamName','awayTeamName','homeCaptainId','awayCaptainId',
      'homeTeamImage','awayTeamImage','status','date','start','end','location',
      'homeTeamGoals','awayTeamGoals'
    ],
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id','firstName','lastName','email','profilePicture','shirtNumber','positionType'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id','firstName','lastName','email','profilePicture','shirtNumber','positionType'] },
      { model: MatchGuest, as: 'guestPlayers', attributes: ['id','team','firstName','lastName','shirtNumber'] },
    ]
  });

  if (!match || String(match.leagueId) !== String(leagueId)) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'Match not found' };
    return;
  }

  const homeUsers = ((match as any).homeTeamUsers || []);
  const awayUsers = ((match as any).awayTeamUsers || []);

  // per-match XP (existing logic)
  const xpMap: Record<string, number> = {};
  if ((match as any).status === 'RESULT_PUBLISHED') {
    const homeGoals = Number((match as any).homeTeamGoals || 0);
    const awayGoals = Number((match as any).awayTeamGoals || 0);

    const allStats = await MatchStatistics.findAll({ where: { match_id: matchId } });
    const votes = await Vote.findAll({ where: { matchId } });

    const voteCounts: Record<string, number> = {};
    votes.forEach((v: any) => { const id = String(v.votedForId); voteCounts[id] = (voteCounts[id] || 0) + 1; });
    let motmId: string | null = null; let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]) => { if (count > maxVotes) { motmId = id; maxVotes = count; } });

    const statFor = (userId: string) => allStats.find((s: any) => String(s.user_id) === userId);
    const computeXp = (userId: string, isHome: boolean) => {
      let result: 'win'|'draw'|'lose' = 'lose';
      if (homeGoals === awayGoals) result = 'draw';
      else if ((isHome && homeGoals > awayGoals) || (!isHome && awayGoals > homeGoals)) result = 'win';
      let xp = result === 'win' ? xpPointsTable.winningTeam : result === 'draw' ? xpPointsTable.draw : xpPointsTable.losingTeam;
      const s: any = statFor(userId);
      if (s) {
        const goals = Number(s.goals || 0), assists = Number(s.assists || 0), cleanSheets = Number(s.cleanSheets || 0);
        if (goals) xp += (result === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * goals;
        if (assists) xp += (result === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * assists;
        if (cleanSheets) xp += xpPointsTable.cleanSheet * cleanSheets;
      }
      if (motmId && motmId === userId) xp += (result === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
      if (voteCounts[userId]) xp += (result === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[userId];
      return xp;
    };
    homeUsers.forEach((u: any) => { xpMap[String(u.id)] = computeXp(String(u.id), true); });
    awayUsers.forEach((u: any) => { xpMap[String(u.id)] = computeXp(String(u.id), false); });
  }

  // Fetch saved positions for this match (guard when model missing)
  const positionsHome: Record<string, { x: number; y: number }> = {};
  const positionsAway: Record<string, { x: number; y: number }> = {};
  if (MatchPlayerLayout) {
    const layoutRows = await MatchPlayerLayout.findAll({ where: { matchId } });
    layoutRows.forEach((r: any) => {
      const rec = { x: Number(r.x), y: Number(r.y) };
      if ((r.team as string) === 'home') positionsHome[String(r.userId)] = rec;
      else positionsAway[String(r.userId)] = rec;
    });
  }

  const toPlayer = (u: any) => ({
    id: String(u.id),
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    profilePicture: u.profilePicture,
    shirtNumber: u.shirtNumber ?? undefined,
    positionType: u.positionType ?? undefined,
    xp: xpMap[String(u.id)] !== undefined ? xpMap[String(u.id)] : undefined
  });

  const home = homeUsers.map(toPlayer);
  const away = awayUsers.map(toPlayer);

  const rawGuests = ((match as any).guestPlayers || []);
  const guests = Array.from(new Map(rawGuests.map((g: any) => [String(g.id), g])).values())
    .map((g: any) => ({
      id: g.id,
      team: g.team,
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber,
    }));

  // Auto-role assignment per spec
  const assignRoles = (list: any[]) => {
    const n = list.length;
    const roles: Array<'GK'|'DF'|'MD'|'FW'> = [];
    if (n < 5) { roles.push('GK'); for (let i=1;i<n;i++) roles.push('DF'); }
    else if (n === 5) { roles.push('GK','DF','DF','FW','FW'); }
    else if (n === 6) { roles.push('GK','DF','DF','DF','FW','FW'); }
    else if (n === 7) { roles.push('GK','DF','DF','DF','FW','FW','FW'); }
    else { roles.push('GK','DF','DF','DF'); for (let i=roles.length;i<n;i++) roles.push('FW'); }
    return list.map((p, i) => ({ ...p, role: roles[i] || 'FW' }));
  };

  ctx.body = {
    success: true,
    match: {
      id: String(match.id),
      leagueId: String(match.leagueId),
      homeTeamName: (match as any).homeTeamName,
      awayTeamName: (match as any).awayTeamName,
      homeTeamImage: (match as any).homeTeamImage,
      awayTeamImage: (match as any).awayTeamImage,
      status: (match as any).status,
      date: (match as any).date,
      start: (match as any).start,
      end: (match as any).end,
      location: (match as any).location,
      homeCaptainId: (match as any).homeCaptainId ? String((match as any).homeCaptainId) : undefined,
      awayCaptainId: (match as any).awayCaptainId ? String((match as any).awayCaptainId) : undefined,
      homeTeam: assignRoles(home),
      awayTeam: assignRoles(away),
      guests,
      // saved positions (normalized 0..1 coords)
      positions: { home: positionsHome, away: positionsAway }
    }
  };
});

// Save layout (only captain can modify)
router.patch('/:leagueId/matches/:matchId/layout', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, positions } = ctx.request.body as { team: 'home'|'away'; positions: Record<string, { x: number, y: number }> };

  // Ensure model is available
  if (!MatchPlayerLayout) {
    ctx.status = 501;
    ctx.body = { success: false, message: 'Layout persistence not enabled on server (model missing)' };
    return;
  }

  const match = await Match.findByPk(matchId, { attributes: ['id','leagueId','homeCaptainId','awayCaptainId'] });
  if (!match || String(match.leagueId) !== String(leagueId)) {
    ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return;
  }

  const userId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);
  // Allow either captain to save layout for any team
  const isCaptainOfMatch =
    String((match as any).homeCaptainId) === userId ||
    String((match as any).awayCaptainId) === userId;

  if (!isCaptainOfMatch) {
    ctx.status = 403;
    ctx.body = { success: false, message: 'Only a match captain can save layout' };
    return;
  }

  const entries = Object.entries(positions || {});
  for (const [pid, pos] of entries) {
    const x = Math.max(0, Math.min(1, Number((pos as any).x)));
    const y = Math.max(0, Math.min(1, Number((pos as any).y)));
    const payload = { matchId, userId: pid, team, x, y };

    if (typeof (MatchPlayerLayout as any).upsert === 'function') {
      await (MatchPlayerLayout as any).upsert(payload);
    } else {
      const row = await MatchPlayerLayout.findOne({ where: { matchId, userId: pid } });
      if (row) await row.update(payload);
      else await MatchPlayerLayout.create(payload as any);
    }
  }

  ctx.body = { success: true };
});

export default router;

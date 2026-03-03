import { Context } from 'koa';
import Season from '../models/Season';
import League from '../models/League';
import User from '../models/User';
import Notification from '../models/Notification';

export const getAllSeasons = async (ctx: Context) => {
  const { leagueId } = ctx.params;
  const userId = ctx.state.user?.userId;

  // Check if user is admin of this league
  const league = await League.findByPk(leagueId, {
    include: [
      {
        model: User,
        as: 'administeredLeagues',
        attributes: ['id']
      }
    ]
  });
  
  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }

  const isAdmin = (league as any).administeredLeagues?.some((admin: any) => String(admin.id) === String(userId));

  const seasons = await Season.findAll({
    where: { leagueId },
    order: [['seasonNumber', 'DESC']],
    include: [
      {
        model: User,
        as: 'players',
        attributes: ['id', 'email', 'firstName', 'lastName']
      }
    ]
  });

  // If user is admin, show ALL seasons
  if (isAdmin) {
    const allSeasons = seasons.map((season) => {
      const players = (season as any).players || [];
      const isPlayerInSeason = players.some((p: any) => String(p.id) === String(userId));
      return {
        id: season.id,
        seasonNumber: season.seasonNumber,
        name: season.name,
        isActive: season.isActive,
        startDate: season.startDate,
        endDate: season.endDate,
        maxGames: season.maxGames,
        showPoints: season.showPoints,
        playerCount: players.length,
        createdAt: season.createdAt,
        isMember: isPlayerInSeason
      };
    });

    ctx.body = {
      success: true,
      seasons: allSeasons
    };
    return;
  }

  // For non-admin members - only show seasons where user is a member
  const filteredSeasons = await Promise.all(
    seasons.map(async (season) => {
      const players = (season as any).players || [];
      const isPlayerInSeason = players.some((p: any) => String(p.id) === String(userId));

      // ONLY show season if user is a member of it
      if (isPlayerInSeason) {
        return {
          id: season.id,
          seasonNumber: season.seasonNumber,
          name: season.name,
          isActive: season.isActive,
          startDate: season.startDate,
          endDate: season.endDate,
          maxGames: season.maxGames,
          showPoints: season.showPoints,
          playerCount: players.length,
          createdAt: season.createdAt,
          isMember: true
        };
      }

      // User is not in this season - don't show it at all
      return null;
    })
  );

  ctx.body = {
    success: true,
    seasons: filteredSeasons.filter(s => s !== null)
  };
};

export const getActiveSeason = async (ctx: Context) => {
  const { leagueId } = ctx.params;
  const userId = ctx.state.user?.userId;

  // Check if user is admin of this league
  const league = await League.findByPk(leagueId, {
    include: [
      {
        model: User,
        as: 'administeredLeagues',
        attributes: ['id']
      }
    ]
  });

  const isAdmin = league && (league as any).administeredLeagues?.some((admin: any) => String(admin.id) === String(userId));

  const activeSeason = await Season.findOne({
    where: {
      leagueId,
      isActive: true
    },
    include: [
      {
        model: User,
        as: 'players',
        attributes: ['id', 'email', 'firstName', 'lastName']
      }
    ]
  });

  if (!activeSeason) {
    ctx.body = {
      success: false,
      message: 'No active season found'
    };
    return;
  }

  // If user is ADMIN - always return active season (admin sees everything)
  if (isAdmin) {
    ctx.body = {
      success: true,
      season: {
        id: activeSeason.id,
        seasonNumber: activeSeason.seasonNumber,
        name: activeSeason.name,
        isActive: activeSeason.isActive,
        startDate: activeSeason.startDate,
        endDate: activeSeason.endDate,
        maxGames: activeSeason.maxGames,
        showPoints: activeSeason.showPoints,
        players: (activeSeason as any).players,
        createdAt: activeSeason.createdAt
      }
    };
    return;
  }

  // Check if user is a member of the active season
  const players = (activeSeason as any).players || [];
  const isUserInActiveSeason = players.some((p: any) => String(p.id) === String(userId));

  // If user is in the active season, return it
  if (isUserInActiveSeason) {
    ctx.body = {
      success: true,
      season: {
        id: activeSeason.id,
        seasonNumber: activeSeason.seasonNumber,
        name: activeSeason.name,
        isActive: activeSeason.isActive,
        startDate: activeSeason.startDate,
        endDate: activeSeason.endDate,
        maxGames: activeSeason.maxGames,
        showPoints: activeSeason.showPoints,
        players: (activeSeason as any).players,
        createdAt: activeSeason.createdAt
      }
    };
    return;
  }

  // User is NOT in the active season - return their previous season
  const previousSeason = await Season.findOne({
    where: {
      leagueId,
      seasonNumber: activeSeason.seasonNumber - 1
    },
    include: [
      {
        model: User,
        as: 'players',
        attributes: ['id', 'email', 'firstName', 'lastName']
      }
    ]
  });

  if (previousSeason) {
    ctx.body = {
      success: true,
      season: {
        id: previousSeason.id,
        seasonNumber: previousSeason.seasonNumber,
        name: previousSeason.name,
        isActive: false, // Previous season is not active
        startDate: previousSeason.startDate,
        endDate: previousSeason.endDate,
        maxGames: previousSeason.maxGames,
        showPoints: previousSeason.showPoints,
        players: (previousSeason as any).players,
        createdAt: previousSeason.createdAt
      }
    };
    return;
  }

  // If no previous season found, return no season
  ctx.body = {
    success: false,
    message: 'No season found for this user'
  };
};

export const createNewSeason = async (ctx: Context) => {
  const { leagueId } = ctx.params;
  const { copyPlayers = true } = ctx.request.body as { copyPlayers?: boolean };

  // Verify user is league admin
  const league = await League.findByPk(leagueId, {
    include: [
      {
        model: User,
        as: 'administeredLeagues',
        where: { id: ctx.state.user.userId }
      }
    ]
  });

  if (!league) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  // Get current active season
  const currentSeason = await Season.findOne({
    where: {
      leagueId,
      isActive: true
    },
    include: [
      {
        model: User,
        as: 'players'
      }
    ]
  });

  if (!currentSeason) {
    ctx.throw(400, 'No active season found to end');
    return;
  }

  // End current season
  currentSeason.isActive = false;
  currentSeason.endDate = new Date();
  await currentSeason.save();

  console.log(`✅ Season ${currentSeason.seasonNumber} ended for league ${league.name}`);

  // Create new season
  const newSeasonNumber = currentSeason.seasonNumber + 1;
  const newSeason = await Season.create({
    leagueId,
    seasonNumber: newSeasonNumber,
    name: `Season ${newSeasonNumber}`,
    isActive: true,
    startDate: new Date()
  });

  console.log(`✅ Season ${newSeasonNumber} created for league ${league.name}`);

  // Get admin user ID
  const adminUserId = ctx.state.user.userId;

  // Automatically add admin to new season (admin is always part of every season)
  try {
    await (newSeason as any).addPlayer(adminUserId);
    console.log(`✅ Admin (user ${adminUserId}) automatically added to Season ${newSeasonNumber}`);
  } catch (addAdminError) {
    console.error('❌ Error adding admin to new season:', addAdminError);
  }

  // Send notification to all league members (EXCEPT admin) asking if they want to join the new season
  try {
    const leagueMembers = await User.findAll({
      include: [
        {
          model: League,
          as: 'leagues',
          where: { id: leagueId },
          attributes: [],
          required: true
        }
      ],
      subQuery: false
    });

    console.log(`📊 Found ${leagueMembers.length} league members before deduplication`);
    
    // Remove duplicates - ensure each user gets only one notification
    const uniqueMembers = Array.from(
      new Map(leagueMembers.map(member => [member.id, member])).values()
    );

    // Filter out the admin - admin doesn't need notification as they're auto-added
    const nonAdminMembers = uniqueMembers.filter(member => String(member.id) !== String(adminUserId));

    console.log(`📊 After deduplication and excluding admin: ${nonAdminMembers.length} members to notify`);

    // Create notifications for all non-admin league members
    const notificationPromises = nonAdminMembers.map(async (member) => {
      console.log(`📤 Sending notification to user ${member.id}`);
      return Notification.create({
        user_id: member.id,
        type: 'NEW_SEASON',
        title: `New Season Started in ${league.name}!`,
        body: `Season ${newSeasonNumber} has just begun! Would you like to join this season? If you don't respond, you won't be automatically added.`,
        meta: {
          leagueId,
          leagueName: league.name,
          seasonId: newSeason.id,
          seasonNumber: newSeasonNumber,
          actionRequired: true
        },
        read: false,
        created_at: new Date()
      });
    });

    await Promise.all(notificationPromises);
    console.log(`✅ Sent NEW_SEASON notifications to ${nonAdminMembers.length} league members (admin excluded)`);
  } catch (notifError) {
    console.error('❌ Error sending season notifications:', notifError);
    // Don't fail the season creation if notifications fail
  }

  ctx.body = {
    success: true,
    message: `Season ${newSeasonNumber} created successfully`,
    previousSeason: {
      id: currentSeason.id,
      seasonNumber: currentSeason.seasonNumber,
      endDate: currentSeason.endDate
    },
    newSeason: {
      id: newSeason.id,
      seasonNumber: newSeason.seasonNumber,
      name: newSeason.name,
      startDate: newSeason.startDate,
      isActive: newSeason.isActive
    }
  };
};

export const addPlayerToSeason = async (ctx: Context) => {
  const { leagueId, userId } = ctx.params;

  // Verify user is league admin
  const league = await League.findByPk(leagueId, {
    include: [
      {
        model: User,
        as: 'administeredLeagues',
        where: { id: ctx.state.user.userId }
      }
    ]
  });

  if (!league) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  // Get active season
  const activeSeason = await Season.findOne({
    where: {
      leagueId,
      isActive: true
    }
  });

  if (!activeSeason) {
    ctx.throw(400, 'No active season found');
    return;
  }

  // Check if user exists
  const user = await User.findByPk(userId);
  if (!user) {
    ctx.throw(404, 'User not found');
    return;
  }

  // Add player to season
  await (activeSeason as any).addPlayer(userId);

  ctx.body = {
    success: true,
    message: `Player added to ${activeSeason.name}`
  };
};

export const removePlayerFromSeason = async (ctx: Context) => {
  const { leagueId, userId } = ctx.params;

  // Verify user is league admin
  const league = await League.findByPk(leagueId, {
    include: [
      {
        model: User,
        as: 'administeredLeagues',
        where: { id: ctx.state.user.userId }
      }
    ]
  });

  if (!league) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  // Get active season
  const activeSeason = await Season.findOne({
    where: {
      leagueId,
      isActive: true
    }
  });

  if (!activeSeason) {
    ctx.throw(400, 'No active season found');
    return;
  }

  // Remove player from season
  await (activeSeason as any).removePlayer(userId);

  ctx.body = {
    success: true,
    message: `Player removed from ${activeSeason.name}`
  };
};

export const updateSeason = async (ctx: Context) => {
  const { seasonId } = ctx.params;
  const { maxGames, showPoints } = ctx.request.body as { maxGames?: number; showPoints?: boolean };

  // Find the season and its league
  const season = await Season.findByPk(seasonId, {
    include: [
      {
        model: League,
        as: 'league',
        include: [
          {
            model: User,
            as: 'administeredLeagues',
            attributes: ['id']
          }
        ]
      }
    ]
  });

  if (!season) {
    ctx.throw(404, 'Season not found');
    return;
  }

  // Verify user is league admin
  const league = (season as any).league;
  const userId = ctx.state.user.userId || ctx.state.user.id;
  
  const adminList = league?.administeredLeagues || [];
  console.log('🔍 updateSeason admin check:', {
    userId,
    leagueId: league?.id,
    leagueFound: !!league,
    adminList: adminList.map((a: any) => a.id),
    adminCount: adminList.length
  });
  
  let isAdmin = adminList.some((admin: any) => String(admin.id) === String(userId));
  
  if (!isAdmin && league?.id) {
    // Fallback: direct query on LeagueAdmin table
    const directResult = await (League as any).sequelize.query(
      'SELECT "userId" FROM "LeagueAdmin" WHERE "leagueId" = :leagueId AND "userId" = :userId LIMIT 1',
      { replacements: { leagueId: league.id, userId }, type: (League as any).sequelize.QueryTypes.SELECT }
    );
    console.log('🔍 updateSeason fallback query result:', JSON.stringify(directResult));
    isAdmin = Array.isArray(directResult) && directResult.length > 0;
  }

  if (!isAdmin) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  // Update season settings
  if (maxGames !== undefined) {
    season.maxGames = maxGames;
  }
  if (showPoints !== undefined) {
    season.showPoints = showPoints;
  }

  await season.save();

  ctx.body = {
    success: true,
    message: 'Season settings updated',
    season: {
      id: season.id,
      maxGames: season.maxGames,
      showPoints: season.showPoints
    }
  };
};

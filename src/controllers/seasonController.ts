import { Context } from 'koa';
import Season from '../models/Season';
import League from '../models/League';
import User from '../models/User';
import Notification from '../models/Notification';
import Match from '../models/Match';
import { Op, QueryTypes } from 'sequelize';
import { randomUUID } from 'crypto';

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return undefined;
};

const getSeasonStatus = (season: Season): 'active' | 'inactive' | 'archived' | 'deleted' => {
  if ((season as any).deleted) return 'deleted';
  if ((season as any).archived) return 'archived';
  if (season.isActive) return 'active';
  return 'inactive';
};

const buildSeasonPayload = (season: Season, extra?: Record<string, unknown>) => ({
  id: season.id,
  leagueId: season.leagueId,
  seasonNumber: season.seasonNumber,
  name: season.name,
  isActive: season.isActive,
  archived: Boolean((season as any).archived),
  deleted: Boolean((season as any).deleted),
  status: getSeasonStatus(season),
  startDate: season.startDate,
  endDate: season.endDate,
  maxGames: season.maxGames,
  showPoints: season.showPoints,
  createdAt: season.createdAt,
  updatedAt: season.updatedAt,
  ...(extra || {}),
});

const checkLeagueAdmin = async (leagueId: string, userId: string): Promise<{ league: League | null; isAdmin: boolean }> => {
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
    return { league: null, isAdmin: false };
  }

  const adminList = (league as any).administeredLeagues || [];
  let isAdmin = adminList.some((admin: any) => String(admin.id) === String(userId));

  if (!isAdmin) {
    const directResult = await (League as any).sequelize.query(
      'SELECT "userId" FROM "LeagueAdmin" WHERE "leagueId" = :leagueId AND "userId" = :userId LIMIT 1',
      { replacements: { leagueId, userId }, type: (League as any).sequelize.QueryTypes.SELECT }
    );
    isAdmin = Array.isArray(directResult) && directResult.length > 0;
  }

  return { league, isAdmin };
};

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
    where: { leagueId, deleted: false },
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
        archived: Boolean((season as any).archived),
        deleted: Boolean((season as any).deleted),
        status: getSeasonStatus(season),
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
          archived: Boolean((season as any).archived),
          deleted: Boolean((season as any).deleted),
          status: getSeasonStatus(season),
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
      isActive: true,
      archived: false,
      deleted: false,
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
        ...buildSeasonPayload(activeSeason),
        players: (activeSeason as any).players,
      },
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
        ...buildSeasonPayload(activeSeason),
        players: (activeSeason as any).players,
      },
    };
    return;
  }

  // User is NOT in the active season - return their previous season
  const previousSeason = await Season.findOne({
    where: {
      leagueId,
      seasonNumber: activeSeason.seasonNumber - 1,
      deleted: false,
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
        ...buildSeasonPayload(previousSeason as Season, { isActive: false }),
        players: (previousSeason as any).players,
      },
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
  void copyPlayers;

  const adminUserId = String(ctx.state.user?.userId || ctx.state.user?.id || '');
  const { league, isAdmin } = await checkLeagueAdmin(String(leagueId), adminUserId);

  if (!league || !isAdmin) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  const sequelizeRef = (Season as any).sequelize;
  const partialSeasonUniqueIndexRows = await sequelizeRef.query(
    `
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'Seasons'
      AND indexname = 'seasons_league_id_season_number_active'
    LIMIT 1;
    `,
    { type: QueryTypes.SELECT }
  );
  const usePartialConflictClause = Array.isArray(partialSeasonUniqueIndexRows) && partialSeasonUniqueIndexRows.length > 0;
  const conflictClause = usePartialConflictClause
    ? 'ON CONFLICT ("leagueId","seasonNumber") WHERE "deleted" = false DO NOTHING'
    : 'ON CONFLICT ("leagueId","seasonNumber") DO NOTHING';

  let currentSeason: Season | null = null;
  let newSeason: Season | null = null;
  let newSeasonNumber = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tx = await sequelizeRef.transaction();
    try {
      // Serialize season creation per league to avoid race conditions on seasonNumber.
      const lockedLeague = await League.findByPk(leagueId, {
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });

      if (!lockedLeague) {
        await tx.rollback();
        ctx.throw(404, 'League not found');
        return;
      }

      currentSeason = await Season.findOne({
        where: {
          leagueId,
          isActive: true,
          archived: false,
          deleted: false,
        },
        order: [['seasonNumber', 'DESC']],
        transaction: tx,
      });

      // If an active season exists, end it first. If not, still allow creating a new season.
      if (currentSeason) {
        currentSeason.isActive = false;
        currentSeason.endDate = currentSeason.endDate || new Date();
        await currentSeason.save({ transaction: tx });
      }

      // Numbering rule (updated):
      // Always create the next season after the highest historical season number,
      // even if some old seasons are archived/deleted.
      const allSeasons = await Season.findAll({
        where: { leagueId },
        attributes: ['seasonNumber'],
        transaction: tx,
      });

      let maxSeasonNumber = 0;
      for (const s of allSeasons) {
        const n = Number((s as any).seasonNumber || 0);
        if (Number.isInteger(n) && n > maxSeasonNumber) {
          maxSeasonNumber = n;
        }
      }

      let candidate = maxSeasonNumber + 1;
      // Insert with ON CONFLICT DO NOTHING so duplicate seasonNumber never aborts the tx.
      // This handles race conditions and old unique-constraint states safely.
      let insertedSeasonId = '';
      let insertGuard = 0;
      while (!insertedSeasonId && insertGuard < Math.max(maxSeasonNumber + 25, 25)) {
        const now = new Date();
        const replacements = {
          id: randomUUID(),
          leagueId,
          seasonNumber: candidate,
          name: `Season ${candidate}`,
          startDate: now,
          snapshot: '{}',
          createdAt: now,
          updatedAt: now,
        };

        const insertRowsRaw = await sequelizeRef.query(
          `
          INSERT INTO "Seasons"
            ("id","leagueId","seasonNumber","name","isActive","archived","deleted","startDate","showPoints","trophyAwardSnapshot","createdAt","updatedAt")
          VALUES
            (:id,:leagueId,:seasonNumber,:name,true,false,false,:startDate,false,:snapshot::jsonb,:createdAt,:updatedAt)
          ${conflictClause}
          RETURNING "id","seasonNumber";
          `,
          {
            replacements,
            type: QueryTypes.SELECT,
            transaction: tx,
          }
        );
        const insertRows = (insertRowsRaw || []) as Array<{ id: string; seasonNumber: number }>;

        if (Array.isArray(insertRows) && insertRows.length > 0) {
          insertedSeasonId = String(insertRows[0].id);
          newSeasonNumber = Number(insertRows[0].seasonNumber || candidate);
          break;
        }

        candidate += 1;
        insertGuard += 1;
      }

      if (!insertedSeasonId) {
        throw new Error('Unable to allocate a unique season number');
      }

      const seasonInTx = await Season.findByPk(insertedSeasonId, { transaction: tx });
      if (!seasonInTx) {
        throw new Error('New season insert succeeded but record was not found');
      }
      newSeason = seasonInTx;

      try {
        await (newSeason as any).addPlayer(adminUserId, { transaction: tx });
      } catch (addAdminError) {
        console.error('Error adding admin to new season:', addAdminError);
      }

      await tx.commit();
      break;
    } catch (error) {
      try { await tx.rollback(); } catch {}
      const err = error as { original?: { code?: string; constraint?: string; message?: string }; message?: string };
      const code = err?.original?.code || '';
      console.error('[createNewSeason] attempt failed', {
        attempt: attempt + 1,
        code,
        constraint: err?.original?.constraint || '',
        message: err?.original?.message || err?.message || 'unknown',
      });

      // Retry transient/transaction issues once or twice with fresh tx.
      if (['25P02', '40001', '40P01'].includes(code) && attempt < 2) continue;
      throw error;
    }
  }

  if (!newSeason) {
    ctx.throw(500, 'Failed to create a new season');
    return;
  }

  if (currentSeason) {
    console.log(`Season ${currentSeason.seasonNumber} ended for league ${league.name}`);
  } else {
    console.log(`No active season found in league ${league.name}; creating a fresh active season`);
  }
  console.log(`Season ${newSeasonNumber} created for league ${league.name}`);

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

    console.log(`Found ${leagueMembers.length} league members before deduplication`);

    // Remove duplicates - ensure each user gets only one notification
    const uniqueMembers = Array.from(
      new Map(leagueMembers.map(member => [member.id, member])).values()
    );

    // Filter out the admin - admin doesn't need notification as they're auto-added
    const nonAdminMembers = uniqueMembers.filter(member => String(member.id) !== String(adminUserId));

    console.log(`After deduplication and excluding admin: ${nonAdminMembers.length} members to notify`);

    // Create notifications for all non-admin league members
    const notificationPromises = nonAdminMembers.map(async (member) => {
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
    console.log(`Sent NEW_SEASON notifications to ${nonAdminMembers.length} league members (admin excluded)`);
  } catch (notifError) {
    console.error('Error sending season notifications:', notifError);
    // Don't fail the season creation if notifications fail
  }

  ctx.body = {
    success: true,
    message: `Season ${newSeasonNumber} created successfully`,
    previousSeason: {
      id: currentSeason?.id || null,
      seasonNumber: currentSeason?.seasonNumber || null,
      endDate: currentSeason?.endDate || null
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
      isActive: true,
      archived: false,
      deleted: false,
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
      isActive: true,
      archived: false,
      deleted: false,
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
  const leagueIdParam = ctx.params.leagueId ? String(ctx.params.leagueId) : '';
  const body = (ctx.request.body || {}) as Record<string, unknown>;

  if (!seasonId) {
    ctx.throw(400, 'seasonId is required');
    return;
  }

  const season = await Season.findByPk(seasonId);
  if (!season) {
    ctx.throw(404, 'Season not found');
    return;
  }

  if (Boolean((season as any).deleted)) {
    ctx.throw(410, 'Season has been permanently deleted');
    return;
  }

  if (leagueIdParam && String(season.leagueId) !== leagueIdParam) {
    ctx.throw(404, 'Season not found in this league');
    return;
  }

  const userId = String(ctx.state.user?.userId || ctx.state.user?.id || '');
  const { isAdmin } = await checkLeagueAdmin(String(season.leagueId), userId);
  if (!isAdmin) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  const maxGamesRaw = body.maxGames;
  const showPointsInput = normalizeBoolean(body.showPoints);
  const directActive = normalizeBoolean(body.isActive);
  const activeAlias = normalizeBoolean(body.active);
  const seasonIsActive = normalizeBoolean(body.seasonIsActive);
  const seasonActive = normalizeBoolean(body.seasonActive);
  const directArchived = normalizeBoolean(body.archived);
  const seasonArchived = normalizeBoolean(body.seasonArchived);
  const statusRaw = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  const seasonStatusRaw = typeof body.seasonStatus === 'string' ? body.seasonStatus.trim().toLowerCase() : '';
  const status = seasonStatusRaw || statusRaw;

  let nextArchived = directArchived ?? seasonArchived;
  let nextActive = directActive ?? activeAlias ?? seasonIsActive ?? seasonActive;

  if (status === 'archived') {
    nextArchived = true;
    nextActive = false;
  } else if (status === 'active') {
    nextArchived = false;
    nextActive = true;
  } else if (status === 'inactive') {
    if (nextArchived === undefined) nextArchived = false;
    nextActive = false;
  }

  if (nextArchived === true) {
    nextActive = false;
  }
  if (nextActive === true && nextArchived === undefined) {
    nextArchived = false;
  }

  const tx = await (Season as any).sequelize.transaction();
  try {
    const seasonInTx = await Season.findByPk(seasonId, { transaction: tx });
    if (!seasonInTx) {
      await tx.rollback();
      ctx.throw(404, 'Season not found');
      return;
    }

    if (Boolean((seasonInTx as any).deleted)) {
      await tx.rollback();
      ctx.throw(410, 'Season has been permanently deleted');
      return;
    }

    if (maxGamesRaw !== undefined && maxGamesRaw !== null && maxGamesRaw !== '') {
      const parsedMaxGames = Number(maxGamesRaw);
      if (!Number.isNaN(parsedMaxGames)) {
        seasonInTx.maxGames = parsedMaxGames;
      }
    }

    if (showPointsInput !== undefined) {
      seasonInTx.showPoints = showPointsInput;
    }

    if (nextArchived !== undefined) {
      (seasonInTx as any).archived = nextArchived;
    }
    if (nextActive !== undefined) {
      seasonInTx.isActive = nextActive;
    }

    if ((seasonInTx as any).archived === true || seasonInTx.isActive === false) {
      if (!seasonInTx.endDate) {
        seasonInTx.endDate = new Date();
      }
    }

    if (seasonInTx.isActive === true) {
      await Season.update(
        { isActive: false },
        {
          where: {
            leagueId: seasonInTx.leagueId,
            id: { [Op.ne]: seasonInTx.id },
            deleted: false,
          },
          transaction: tx,
        }
      );
    }

    await seasonInTx.save({ transaction: tx });

    if ((seasonInTx as any).archived === true || seasonInTx.isActive === false) {
      const activeNonArchived = await Season.findOne({
        where: {
          leagueId: seasonInTx.leagueId,
          isActive: true,
          archived: false,
          deleted: false,
        },
        transaction: tx,
      });

      if (!activeNonArchived) {
        const replacement = await Season.findOne({
          where: {
            leagueId: seasonInTx.leagueId,
            archived: false,
            deleted: false,
            id: { [Op.ne]: seasonInTx.id },
          },
          order: [['seasonNumber', 'DESC']],
          transaction: tx,
        });

        if (replacement) {
          replacement.isActive = true;
          await replacement.save({ transaction: tx });
        }
      }
    }

    await tx.commit();

    const refreshed = await Season.findByPk(seasonId);
    const seasonOut = refreshed || seasonInTx;
    const archivedNow = Boolean((seasonOut as any).archived);

    ctx.body = {
      success: true,
      message: archivedNow ? 'Season archived successfully' : 'Season updated successfully',
      season: buildSeasonPayload(seasonOut as Season),
    };
  } catch (error) {
    try { await tx.rollback(); } catch {}
    console.error('updateSeason error:', error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to update season',
    };
  }
};

export const updateSeasonStatus = async (ctx: Context) => {
  await updateSeason(ctx);
};

export const archiveSeason = async (ctx: Context) => {
  const incomingBody = (ctx.request.body || {}) as Record<string, unknown>;
  (ctx.request as any).body = {
    ...incomingBody,
    archived: true,
    isActive: false,
    seasonStatus: 'archived',
  };
  await updateSeason(ctx);
};

export const restoreSeason = async (ctx: Context) => {
  const { seasonId } = ctx.params;
  const leagueIdParam = ctx.params.leagueId ? String(ctx.params.leagueId) : '';

  if (!seasonId) {
    ctx.throw(400, 'seasonId is required');
    return;
  }

  const season = await Season.findByPk(seasonId);
  if (!season) {
    ctx.throw(404, 'Season not found');
    return;
  }

  if (leagueIdParam && String(season.leagueId) !== leagueIdParam) {
    ctx.throw(404, 'Season not found in this league');
    return;
  }

  if (Boolean((season as any).deleted)) {
    ctx.throw(400, 'This season is permanently deleted and cannot be restored');
    return;
  }

  const userId = String(ctx.state.user?.userId || ctx.state.user?.id || '');
  const { isAdmin } = await checkLeagueAdmin(String(season.leagueId), userId);
  if (!isAdmin) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  const tx = await (Season as any).sequelize.transaction();
  try {
    const seasonInTx = await Season.findByPk(seasonId, { transaction: tx });
    if (!seasonInTx) {
      await tx.rollback();
      ctx.throw(404, 'Season not found');
      return;
    }

    if (Boolean((seasonInTx as any).deleted)) {
      await tx.rollback();
      ctx.throw(400, 'This season is permanently deleted and cannot be restored');
      return;
    }

    (seasonInTx as any).archived = false;

    const existingActive = await Season.findOne({
      where: {
        leagueId: seasonInTx.leagueId,
        isActive: true,
        archived: false,
        deleted: false,
        id: { [Op.ne]: seasonInTx.id },
      },
      transaction: tx,
    });

    seasonInTx.isActive = !existingActive;
    if (seasonInTx.isActive) {
      seasonInTx.endDate = null as any;
      await Season.update(
        { isActive: false },
        {
          where: {
            leagueId: seasonInTx.leagueId,
            id: { [Op.ne]: seasonInTx.id },
            deleted: false,
          },
          transaction: tx,
        }
      );
    }

    await seasonInTx.save({ transaction: tx });
    await tx.commit();

    const refreshed = await Season.findByPk(seasonId);
    const seasonOut = refreshed || seasonInTx;
    ctx.body = {
      success: true,
      message: 'Season restored successfully',
      season: buildSeasonPayload(seasonOut as Season),
    };
  } catch (error) {
    try { await tx.rollback(); } catch {}
    console.error('restoreSeason error:', error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to restore season',
    };
  }
};

export const permanentDeleteSeason = async (ctx: Context) => {
  const { seasonId } = ctx.params;
  const leagueIdParam = ctx.params.leagueId ? String(ctx.params.leagueId) : '';

  if (!seasonId) {
    ctx.throw(400, 'seasonId is required');
    return;
  }

  const season = await Season.findByPk(seasonId);
  if (!season) {
    ctx.throw(404, 'Season not found');
    return;
  }

  if (leagueIdParam && String(season.leagueId) !== leagueIdParam) {
    ctx.throw(404, 'Season not found in this league');
    return;
  }

  const userId = String(ctx.state.user?.userId || ctx.state.user?.id || '');
  const { isAdmin } = await checkLeagueAdmin(String(season.leagueId), userId);
  if (!isAdmin) {
    ctx.throw(403, 'You are not an administrator of this league');
    return;
  }

  const tx = await (Season as any).sequelize.transaction();
  try {
    const seasonInTx = await Season.findByPk(seasonId, { transaction: tx });
    if (!seasonInTx) {
      await tx.rollback();
      ctx.throw(404, 'Season not found');
      return;
    }

    (seasonInTx as any).deleted = true;
    (seasonInTx as any).archived = true;
    seasonInTx.isActive = false;
    if (!seasonInTx.endDate) {
      seasonInTx.endDate = new Date();
    }
    await seasonInTx.save({ transaction: tx });

    await Match.update(
      { archived: true },
      {
        where: {
          leagueId: seasonInTx.leagueId,
          seasonId: seasonInTx.id,
        },
        transaction: tx,
      }
    );

    // After deletion, always keep latest remaining non-archived season as active.
    const replacement = await Season.findOne({
      where: {
        leagueId: seasonInTx.leagueId,
        deleted: false,
        archived: false,
        id: { [Op.ne]: seasonInTx.id },
      },
      order: [['seasonNumber', 'DESC']],
      transaction: tx,
    });

    if (replacement) {
      await Season.update(
        { isActive: false },
        {
          where: {
            leagueId: seasonInTx.leagueId,
            deleted: false,
            archived: false,
            id: { [Op.ne]: replacement.id },
          },
          transaction: tx,
        }
      );

      replacement.isActive = true;
      replacement.endDate = null as any;
      await replacement.save({ transaction: tx });
    }

    await tx.commit();

    ctx.body = {
      success: true,
      message: 'Season permanently deleted (data preserved for history/awards/xp)',
    };
  } catch (error) {
    try { await tx.rollback(); } catch {}
    console.error('permanentDeleteSeason error:', error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to permanently delete season',
    };
  }
};


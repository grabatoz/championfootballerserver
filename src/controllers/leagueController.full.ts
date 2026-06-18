import { Context } from 'koa';
import models from '../models';
import { Op, fn, col, where, QueryTypes } from 'sequelize';
import cache from '../utils/cache';
import { uploadToCloudinary } from '../middleware/upload';
import { getInviteCode } from '../modules/utils';
import Season from '../models/Season';
import Notification from '../models/Notification';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { MatchAvailability } from '../models/MatchAvailability';
import { MatchPlayerLayout } from '../models/MatchPlayerLayout';
import { checkLeagueCompletion, checkLeagueCompletionBulk } from '../utils/leagueCompletion';
import { invalidateCache as invalidateServerCache } from '../middleware/memoryCache';
import { registeredUserWhere } from '../utils/playerIdentity';

const { League, Match, User, MatchGuest } = models;

const importWithFallback = async <T = any>(specifier: string): Promise<T> => {
  try {
    return await import(specifier);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      return await import(specifier.slice(0, -3) + '.ts');
    }
    throw err;
  }
};

// Helper functions
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const normalizeTeam = (v: unknown): 'home' | 'away' =>
  String(v || '').toLowerCase().includes('away') ? 'away' : 'home';

type ApiMatchStatus = 'RESULT_PUBLISHED' | 'SCHEDULED' | 'ONGOING';

const normalizeStatus = (s?: string): ApiMatchStatus => {
  const v = String(s ?? '').toLowerCase();
  if (['result_published', 'result_uploaded', 'uploaded', 'complete', 'finished', 'ended', 'done'].includes(v)) return 'RESULT_PUBLISHED';
  if (['ongoing', 'inprogress', 'in_progress', 'live', 'playing'].includes(v)) return 'ONGOING';
  return 'SCHEDULED';
};

const MIN_TOTAL_PLAYERS_FOR_TEAM_UPLOAD = 8;
const MIN_REGISTERED_PLAYERS_FOR_TEAM_UPLOAD = 6;
const MIN_REGISTERED_PLAYERS_MESSAGE = 'A minimum of 6 registered players is required to choose teams';
const MIN_TOTAL_PLAYERS_MESSAGE = 'A minimum of 8 total players (including at least 6 registered league players) is required to save teams.';
const FINALIZED_MATCH_STATUSES = new Set(['RESULT_UPLOADED', 'RESULT_PUBLISHED']);

const parseJsonArrayField = (value: unknown, fieldName: string): any[] => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error(`${fieldName} must be a JSON array`);
      }
      return parsed;
    } catch {
      throw new Error(`Invalid ${fieldName} payload`);
    }
  }
  throw new Error(`Invalid ${fieldName} payload`);
};

const validateTeamUploadThresholds = (registeredPlayers: number, totalPlayers: number): string | null => {
  if (registeredPlayers < MIN_REGISTERED_PLAYERS_FOR_TEAM_UPLOAD) {
    return MIN_REGISTERED_PLAYERS_MESSAGE;
  }
  if (totalPlayers < MIN_TOTAL_PLAYERS_FOR_TEAM_UPLOAD) {
    return MIN_TOTAL_PLAYERS_MESSAGE;
  }
  return null;
};

const isFinalizedMatchStatus = (status: unknown): boolean =>
  FINALIZED_MATCH_STATUSES.has(String(status || '').toUpperCase());

const clampPredictionPct = (value: number): number =>
  Math.round(Math.max(20, Math.min(80, Number.isFinite(value) ? value : 50)));

const computeTeamWinPercentages = async (params: {
  homeIds: string[];
  awayIds: string[];
  homeTotal: number;
  awayTotal: number;
}): Promise<{ homeWinPct: number; awayWinPct: number }> => {
  const homeIds = (params.homeIds || []).filter(Boolean);
  const awayIds = (params.awayIds || []).filter(Boolean);
  const homeTotal = Math.max(0, Number(params.homeTotal) || 0);
  const awayTotal = Math.max(0, Number(params.awayTotal) || 0);

  let homeXPSum = 0;
  let awayXPSum = 0;

  if (homeIds.length > 0) {
    const homePlayers = await User.findAll({
      where: { id: { [Op.in]: homeIds } },
      attributes: ['id', 'xp'],
    });
    homeXPSum = homePlayers.reduce((sum: number, player: any) => sum + (Number(player?.xp) || 0), 0);
  }

  if (awayIds.length > 0) {
    const awayPlayers = await User.findAll({
      where: { id: { [Op.in]: awayIds } },
      attributes: ['id', 'xp'],
    });
    awayXPSum = awayPlayers.reduce((sum: number, player: any) => sum + (Number(player?.xp) || 0), 0);
  }

  const homeAvg = homeTotal > 0 ? homeXPSum / homeTotal : 0;
  const awayAvg = awayTotal > 0 ? awayXPSum / awayTotal : 0;
  const total = homeAvg + awayAvg;

  const homeWinPct = total > 0 ? clampPredictionPct((homeAvg / total) * 100) : 50;
  return {
    homeWinPct,
    awayWinPct: 100 - homeWinPct,
  };
};

const getMatchTeamManagementContext = async (matchId: string): Promise<any | null> => {
  return Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'status', 'homeCaptainId', 'awayCaptainId'],
    include: [
      {
        model: League,
        as: 'league',
        attributes: ['id'],
        include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }],
      },
    ],
  });
};

const hasTeamManagementPermission = (match: any, userId: string, team: 'home' | 'away'): boolean => {
  const isAdmin = Boolean(
    match?.league?.administeredLeagues?.some((admin: any) => String(admin?.id) === String(userId))
  );
  if (isAdmin) return true;

  const captainId = team === 'away' ? String(match?.awayCaptainId || '') : String(match?.homeCaptainId || '');
  return captainId !== '' && captainId === String(userId);
};

const removeUserFromLeagueMatchAssignments = async (leagueId: string, userId: string): Promise<void> => {
  const sequelize = League.sequelize!;
  const replacements = { leagueId, userId };

  await sequelize.query(
    `DELETE FROM "UserHomeMatches" uhm
     USING "Matches" m
     WHERE uhm."matchId" = m.id
       AND m."leagueId" = :leagueId
       AND uhm."userId" = :userId`,
    { replacements, type: QueryTypes.DELETE }
  );

  await sequelize.query(
    `DELETE FROM "UserAwayMatches" uam
     USING "Matches" m
     WHERE uam."matchId" = m.id
       AND m."leagueId" = :leagueId
       AND uam."userId" = :userId`,
    { replacements, type: QueryTypes.DELETE }
  );

  await sequelize.query(
    `DELETE FROM match_availabilities ma
     USING "Matches" m
     WHERE ma.match_id = m.id
       AND m."leagueId" = :leagueId
       AND ma.user_id = :userId`,
    { replacements, type: QueryTypes.DELETE }
  );

  await sequelize.query(
    `UPDATE "Matches"
     SET "homeCaptainId" = NULL
     WHERE "leagueId" = :leagueId
       AND "homeCaptainId" = :userId`,
    { replacements, type: QueryTypes.UPDATE }
  );

  await sequelize.query(
    `UPDATE "Matches"
     SET "awayCaptainId" = NULL
     WHERE "leagueId" = :leagueId
       AND "awayCaptainId" = :userId`,
    { replacements, type: QueryTypes.UPDATE }
  );
};

const toUserBasic = (p: any) => ({
  id: String(p?.id ?? ''),
  firstName: p?.firstName ?? '',
  lastName: p?.lastName ?? '',
  position: p?.positionType ?? p?.position ?? undefined,
  xp: typeof p?.xp === 'number' ? p.xp : (p?.xp ? Number(p.xp) : undefined),
});

const generateUniqueSeasonInviteCode = async (): Promise<string> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = String(getInviteCode() || '').trim().toUpperCase();
    if (!candidate) continue;
    const existing = await Season.findOne({
      where: { inviteCode: candidate } as any,
      attributes: ['id'],
    });
    if (!existing) return candidate;
  }
  throw new Error('Unable to generate a unique season invite code');
};

type LeagueListRow = {
  id: string;
  name: string;
  active: boolean;
  archived: boolean;
  image: string | null;
  maxGames: number | null;
  createdAt?: string;
};

const fetchUserLeaguesBasic = async (userId: string): Promise<LeagueListRow[]> => {
  const sequelize = League.sequelize!;
  const rows = await sequelize.query<LeagueListRow>(
    `
      SELECT DISTINCT
        l.id::text AS id,
        l.name,
        l.active,
        COALESCE(l.archived, false) AS archived,
        l.image,
        l."maxGames",
        l."createdAt" AS "createdAt"
      FROM "Leagues" l
      LEFT JOIN "LeagueMember" lm
        ON lm."leagueId" = l.id
      LEFT JOIN "LeagueAdmin" la
        ON la."leagueId" = l.id
      WHERE lm."userId" = :userId
         OR la."userId" = :userId
      ORDER BY l."createdAt" DESC
    `,
    {
      replacements: { userId },
      type: QueryTypes.SELECT,
    }
  );

  return rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    active: Boolean(row.active),
    archived: Boolean(row.archived),
    image: row.image || null,
    maxGames: row.maxGames == null ? null : Number(row.maxGames),
    createdAt: row.createdAt ? ((row.createdAt as any) instanceof Date ? (row.createdAt as any).toISOString() : String(row.createdAt)) : undefined
  }));
};

const deriveLeagueLifecycle = (
  active: boolean,
  archived: boolean,
  computedCompleted?: boolean,
  computedLocked?: boolean
) => {
  const manualCompleted = !archived && active === false;
  const isCompleted = Boolean(computedCompleted) || manualCompleted;
  const isLocked = Boolean(computedLocked) || manualCompleted;
  const status: 'active' | 'inactive' | 'completed' = archived
    ? 'inactive'
    : (active ? 'active' : 'completed');

  return {
    status,
    isComplete: isCompleted,
    isCompleted,
    isLocked,
    locked: isLocked,
  };
};

// Get all leagues for current user
export const getAllLeagues = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }
  const userId = String(ctx.state.user.userId);
  try {
    const leaguesBasic = await fetchUserLeaguesBasic(userId);
    const completionByLeague = await checkLeagueCompletionBulk(leaguesBasic.map((league) => league.id));

    const leagues = leaguesBasic.map((league) => {
      const completionInfo = completionByLeague[league.id];
      const lifecycle = deriveLeagueLifecycle(
        league.active,
        league.archived,
        completionInfo?.isCompleted,
        false
      );
      return {
        id: league.id,
        name: league.name,
        active: league.active,
        archived: league.archived,
        image: league.image,
        maxGames: league.maxGames,
        status: lifecycle.status,
        createdAt: league.createdAt,
        isComplete: lifecycle.isComplete,
        isCompleted: lifecycle.isCompleted,
        isLocked: lifecycle.isLocked,
        computedStatus: {
          isCompleted: lifecycle.isCompleted,
          isComplete: lifecycle.isComplete,
          locked: lifecycle.locked,
          activeSeasonCompleted: Boolean(completionInfo?.activeSeasonCompleted),
          allStatsSubmitted: Boolean(completionInfo?.allStatsSubmitted),
          matchesPlayed: completionInfo?.totalCompletedMatches ?? 0,
          gamesPlayed: completionInfo?.totalCompletedMatches ?? 0,
          maxGames: league.maxGames ?? 0,
          totalMaxGames: completionInfo?.totalMaxGames ?? 0,
          missing: completionInfo?.missing ?? [],
          seasons: (completionInfo?.seasons ?? []).map(s => ({
            seasonId: s.seasonId,
            seasonName: s.seasonName,
            maxGames: s.maxGames,
            completedMatches: s.completedMatches,
            isCompleted: s.isCompleted,
            last2MatchesStatsComplete: s.last2MatchesStatsComplete,
            missingStatsPlayers: s.missingStatsPlayers,
          })),
        },
      };
    });

    ctx.body = { success: true, leagues };
  } catch (err) {
    console.error('GET /leagues failed', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch leagues' };
  }
};

// Get trophy room
export const getTrophyRoom = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }
  const userId = ctx.state.user.userId;
  const leagueIdQ = typeof ctx.query?.leagueId === 'string' ? ctx.query.leagueId.trim() : '';
  const seasonIdQ = typeof ctx.query?.seasonId === 'string' ? ctx.query.seasonId.trim() : '';

  console.log('🏆 [Trophy Room] Request:', { 
    userId, 
    leagueId: leagueIdQ || 'all', 
    seasonId: seasonIdQ || 'all' 
  });

  type PlayerStats = {
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goals: number;
    assists: number;
    motmVotes: number;
    teamGoalsFor: number;
    teamGoalsConceded: number;
    defensiveImpactVotes: number;
  };

  type TrophySnapshotEntry = {
    winnerId: string | null;
    winner: string;
    awardedAt: string | null;
    updatedAt: string | null;
  };
  type TrophySnapshot = Record<string, TrophySnapshotEntry>;

  const toIsoString = (value: unknown): string | null => {
    if (value == null) return null;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? value.toISOString() : null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1_000_000_000_000 ? value * 1000 : value;
      const dt = new Date(ms);
      return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const dt = new Date(ms);
        return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
      }
      const parsed = new Date(trimmed);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    return null;
  };

  const parseSnapshot = (raw: unknown): TrophySnapshot => {
    if (!raw) return {};

    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {};
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: TrophySnapshot = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([title, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const row = value as Record<string, unknown>;
      const winnerIdRaw = row.winnerId;
      const winnerId = winnerIdRaw == null || String(winnerIdRaw).trim() === '' ? null : String(winnerIdRaw);
      const winnerText = typeof row.winner === 'string' && row.winner.trim() ? row.winner.trim() : (winnerId ? '' : 'TBC');

      out[title] = {
        winnerId,
        winner: winnerText || 'TBC',
        awardedAt: toIsoString(row.awardedAt),
        updatedAt: toIsoString(row.updatedAt),
      };
    });
    return out;
  };

  const comparableSnapshot = (snapshot: TrophySnapshot): string => {
    const ordered: Record<string, TrophySnapshotEntry> = {};
    Object.keys(snapshot)
      .sort()
      .forEach((key) => {
        ordered[key] = snapshot[key];
      });
    return JSON.stringify(ordered);
  };

  const countCompleted = (matches: any[]) =>
    matches.filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED').length;

  const calcStats = (matches: any[], members: any[]): Record<string, PlayerStats> => {
    const stats: Record<string, PlayerStats> = {};
    const ensure = (pid: string) => {
      if (!stats[pid]) {
        stats[pid] = {
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          goals: 0,
          assists: 0,
          motmVotes: 0,
          teamGoalsFor: 0,
          teamGoalsConceded: 0,
          defensiveImpactVotes: 0
        };
      }
    };

    members.forEach((p: any) => ensure(String(p.id)));
    matches.forEach((m: any) => {
      (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
      (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
    });

    matches
      .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
      .forEach((m: any) => {
        const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
        const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));

        [...home, ...away].forEach((pid: string) => {
          if (!stats[pid]) return;
          stats[pid].played++;

          // Add goals and assists from playerStats
          if (m.playerStats && m.playerStats[pid]) {
            stats[pid].goals += Number(m.playerStats[pid].goals || 0);
            stats[pid].assists += Number(m.playerStats[pid].assists || 0);
          }
        });

        // Count MOTM votes
        if (m.manOfTheMatchVotes) {
          Object.values(m.manOfTheMatchVotes).forEach((votedForId: any) => {
            const id = String(votedForId);
            if (stats[id]) stats[id].motmVotes++;
          });
        }

        // Count Defensive Impact votes
        if (m.homeDefensiveImpactId) {
          const id = String(m.homeDefensiveImpactId);
          ensure(id);
          stats[id].defensiveImpactVotes++;
        }
        if (m.awayDefensiveImpactId) {
          const id = String(m.awayDefensiveImpactId);
          ensure(id);
          stats[id].defensiveImpactVotes++;
        }

        const homeWon = (m.homeTeamGoals ?? 0) > (m.awayTeamGoals ?? 0);
        const awayWon = (m.awayTeamGoals ?? 0) > (m.homeTeamGoals ?? 0);

        home.forEach(pid => {
          if (!stats[pid]) return;
          if (homeWon) stats[pid].wins++;
          else if (awayWon) stats[pid].losses++;
          else stats[pid].draws++;
          stats[pid].teamGoalsFor += m.homeTeamGoals ?? 0;
          stats[pid].teamGoalsConceded += m.awayTeamGoals ?? 0;
        });

        away.forEach(pid => {
          if (!stats[pid]) return;
          if (awayWon) stats[pid].wins++;
          else if (homeWon) stats[pid].losses++;
          else stats[pid].draws++;
          stats[pid].teamGoalsFor += m.awayTeamGoals ?? 0;
          stats[pid].teamGoalsConceded += m.homeTeamGoals ?? 0;
        });
      });

    return stats;
  };

  try {
    // Cache key for trophy room
    const trCacheKey = `trophy_room_v2_${userId}_${leagueIdQ || 'all'}_${seasonIdQ || 'all'}`;
    const trCached = cache.get(trCacheKey);
    if (trCached) {
      console.log('✅ [Trophy Room] Returning cached data');
      ctx.body = trCached;
      return;
    }

    let leagues: any[];

    if (leagueIdQ && leagueIdQ !== 'all') {
      // FAST PATH: fetch only the specific league directly with members (avoid loading ALL user leagues)
      const league = await League.findByPk(leagueIdQ, {
        attributes: ['id', 'name', 'maxGames', 'active', 'archived'],
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'email', 'position', 'positionType', 'xp'] }
        ]
      });
      if (!league) {
        ctx.body = { success: true, trophyWinners: [], backendTotalXP: 0 };
        return;
      }
      // Fetch league matches separately to avoid query cartesian-product timeout
      const matches = await Match.findAll({
        where: { leagueId: leagueIdQ, status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }, deleted: false },
        attributes: ['id', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId']
      });

      const plainLeague = league.get({ plain: true }) as any;
      plainLeague.matches = matches.map(m => m.get({ plain: true }));
      leagues = [plainLeague];
    } else {
      // ALL leagues: split into lightweight queries to avoid cartesian-product timeout
      const sequelize = League.sequelize!;
      const memberRows: any[] = await sequelize.query(
        `SELECT "leagueId" FROM "LeagueMember" WHERE "userId" = :uid`,
        { replacements: { uid: userId }, type: QueryTypes.SELECT }
      );
      const userLeagueIds = memberRows.map((r: any) => r.leagueId);
      if (!userLeagueIds.length) {
        ctx.body = { success: true, trophyWinners: [], backendTotalXP: 0 };
        return;
      }
      const fetchedLeagues = await League.findAll({
        where: { id: { [Op.in]: userLeagueIds } },
        attributes: ['id', 'name', 'maxGames', 'active', 'archived'],
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'email', 'position', 'positionType', 'xp'] }
        ]
      });

      const matches = await Match.findAll({
        where: { leagueId: { [Op.in]: userLeagueIds }, status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }, deleted: false },
        attributes: ['id', 'leagueId', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId']
      });

      const matchesByLeague: Record<string, any[]> = {};
      matches.forEach(m => {
        const lid = String(m.leagueId);
        if (!matchesByLeague[lid]) matchesByLeague[lid] = [];
        matchesByLeague[lid].push(m.get({ plain: true }));
      });

      leagues = (fetchedLeagues || []).map(l => {
        const plainL = l.get({ plain: true }) as any;
        plainL.matches = matchesByLeague[String(l.id)] || [];
        return plainL;
      });
    }

    // Fetch seasons separately (lightweight query, avoids timeout)
    const seasonQI = Season.sequelize?.getQueryInterface();
    const seasonTableInfo = seasonQI
      ? await seasonQI.describeTable('Seasons').catch(() => null)
      : null;
    const hasTrophySnapshotColumn = Boolean(
      seasonTableInfo && (seasonTableInfo as Record<string, unknown>)['trophyAwardSnapshot']
    );
    const seasonAttributes = hasTrophySnapshotColumn
      ? ['id', 'leagueId', 'seasonNumber', 'name', 'inviteCode', 'isActive', 'maxGames', 'showPoints', 'trophyAwardSnapshot']
      : ['id', 'leagueId', 'seasonNumber', 'name', 'inviteCode', 'isActive', 'maxGames', 'showPoints'];

    const leagueIds = leagues.map((l: any) => String(l.id));
    const allSeasons = leagueIds.length > 0 ? await Season.findAll({
      where: { leagueId: { [Op.in]: leagueIds } },
      attributes: seasonAttributes as string[],
      raw: true,
    }) : [];
    const seasonsByLeague: Record<string, any[]> = {};
    (allSeasons || []).forEach((s: any) => {
      const lid = String(s.leagueId);
      if (!seasonsByLeague[lid]) seasonsByLeague[lid] = [];
      seasonsByLeague[lid].push(s);
    });

    const trophyWinners: any[] = [];
    const seasonSnapshotUpdates: Array<{ seasonId: string; snapshot: TrophySnapshot }> = [];

    const hasValidSnapshot = (seasonRow: any): boolean => {
      if (!hasTrophySnapshotColumn || !seasonRow || !seasonRow.trophyAwardSnapshot) return false;
      const parsed = parseSnapshot(seasonRow.trophyAwardSnapshot);
      return Object.keys(parsed).length > 0;
    };

    // Determine which match details we actually need to fetch (excluding seasons that already have snapshots)
    const neededMatchIds = new Set<string>();
    leagues.forEach((league: any) => {
      const allMatches = league.matches || [];
      const seasons = seasonsByLeague[String(league.id)] || [];
      
      let matchesToUse = allMatches;
      let currentSeasonRow: any | null = null;
      
      if (seasonIdQ && seasonIdQ !== 'all') {
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === seasonIdQ);
        const season = seasons.find((s: any) => String(s.id) === seasonIdQ) || null;
        currentSeasonRow = season;
      } else if (seasons.length > 0) {
        const activeSeason = seasons.find((s: any) => s.isActive) || seasons[0];
        currentSeasonRow = activeSeason;
        const currentSeasonId = String(activeSeason.id);
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === currentSeasonId);
      }
      
      if (!hasValidSnapshot(currentSeasonRow)) {
        matchesToUse.forEach((m: any) => neededMatchIds.add(String(m.id)));
      }
    });

    const allMatchIds = Array.from(neededMatchIds);
    if (allMatchIds.length > 0) {
      const [matchStatRows, voteRows, matchesWithTeams] = await Promise.all([
        MatchStatistics.findAll({
          where: { match_id: { [Op.in]: allMatchIds } },
          attributes: ['match_id', 'user_id', 'goals', 'assists'],
          raw: true,
        }),
        Vote.findAll({
          where: { matchId: { [Op.in]: allMatchIds } },
          attributes: ['matchId', 'voterId', 'votedForId'],
          raw: true,
        }),
        Match.findAll({
          where: { id: { [Op.in]: allMatchIds } },
          attributes: ['id'],
          include: [
            { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'email', 'position', 'positionType'] },
            { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'email', 'position', 'positionType'] }
          ]
        })
      ]);

      const teamsMap = new Map<string, { homeTeamUsers: any[], awayTeamUsers: any[] }>();
      (matchesWithTeams || []).forEach((m: any) => {
        teamsMap.set(String(m.id), {
          homeTeamUsers: (m.homeTeamUsers || []).map((u: any) => u.get({ plain: true })),
          awayTeamUsers: (m.awayTeamUsers || []).map((u: any) => u.get({ plain: true }))
        });
      });

      const psMap: Record<string, Record<string, { goals: number; assists: number }>> = {};
      (matchStatRows || []).forEach((ms: any) => {
        const mid = String(ms.match_id);
        if (!psMap[mid]) psMap[mid] = {};
        const uid = String(ms.user_id);
        const existing = psMap[mid][uid];
        if (existing) {
          existing.goals += Number(ms.goals || 0);
          existing.assists += Number(ms.assists || 0);
        } else {
          psMap[mid][uid] = { goals: Number(ms.goals || 0), assists: Number(ms.assists || 0) };
        }
      });
      const motmMap: Record<string, Record<string, string>> = {};
      (voteRows || []).forEach((v: any) => {
        const mid = String(v.matchId);
        if (!motmMap[mid]) motmMap[mid] = {};
        motmMap[mid][String(v.voterId)] = String(v.votedForId);
      });
      leagues.forEach((l: any) => {
        (l.matches || []).forEach((m: any) => {
          const mid = String(m.id);
          const teams = teamsMap.get(mid);
          m.homeTeamUsers = teams?.homeTeamUsers || [];
          m.awayTeamUsers = teams?.awayTeamUsers || [];
          (m as any).playerStats = psMap[mid] || {};
          (m as any).manOfTheMatchVotes = motmMap[mid] || {};
        });
      });
    }

    leagues.forEach((league: any) => {
      const allMatches = league.matches || [];
      const seasons = seasonsByLeague[String(league.id)] || [];
      
      // Filter matches by season if seasonId is provided
      let matchesToUse = allMatches;
      let currentSeasonId = seasonIdQ;
      let currentSeasonName = '';
      let currentSeasonRow: any | null = null;
      
      if (seasonIdQ && seasonIdQ !== 'all') {
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === seasonIdQ);
        const season = seasons.find((s: any) => String(s.id) === seasonIdQ) || null;
        currentSeasonRow = season;
        currentSeasonName = season?.name || `Season ${season?.seasonNumber || 1}`;
        console.log(`🔍 [Trophy Room] Filtered ${matchesToUse.length} matches for season ${currentSeasonName}`);
      } else if (seasons.length > 0) {
        // Use active season if no specific season is selected
        const activeSeason = seasons.find((s: any) => s.isActive) || seasons[0];
        currentSeasonRow = activeSeason;
        currentSeasonId = String(activeSeason.id);
        currentSeasonName = activeSeason.name || `Season ${activeSeason.seasonNumber}`;
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === currentSeasonId);
        console.log(`🔍 [Trophy Room] Using active season ${currentSeasonName} with ${matchesToUse.length} matches`);
      }

      if (hasValidSnapshot(currentSeasonRow)) {
        console.log(`🏆 [Trophy Room] Using cached snapshot for season: ${currentSeasonName}`);
        const snapshot = parseSnapshot(currentSeasonRow.trophyAwardSnapshot);
        Object.entries(snapshot).forEach(([title, entry]) => {
          trophyWinners.push({
            title,
            winnerId: entry.winnerId,
            winner: entry.winner,
            leagueId: String(league.id),
            leagueName: league.name,
            seasonId: currentSeasonId || undefined,
            seasonName: currentSeasonName || undefined,
            awardedAt: entry.awardedAt,
            updatedAt: entry.updatedAt,
          });
        });
        return;
      }

      // Awards should only be calculated for completed season/league scopes.
      const completedMatches = countCompleted(matchesToUse);
      const scopedMaxGames = Number(currentSeasonRow?.maxGames ?? league.maxGames ?? 0);
      const scopeCompleted = (() => {
        if (scopedMaxGames > 0) return completedMatches >= scopedMaxGames;
        if (currentSeasonRow) {
          if (currentSeasonRow.archived === true || currentSeasonRow.isActive === false) {
            return completedMatches > 0;
          }
          return false;
        }
        const leagueArchivedOrInactive = Boolean((league as any)?.archived === true || (league as any)?.active === false);
        return leagueArchivedOrInactive && completedMatches > 0;
      })();

      if (!scopeCompleted) {
        console.log(`[Trophy Room] Skip incomplete scope: league=${league.name}, season=${currentSeasonName || 'n/a'}, completed=${completedMatches}, maxGames=${scopedMaxGames}`);
        return;
      }

      const stats = calcStats(matchesToUse, league.members || []);
      const playerIds = Object.keys(stats).filter(id => stats[id].played > 0);

      const memberXp: Record<string, number> = {};
      (league.members || []).forEach((p: any) => {
        memberXp[String(p.id)] = Number(p.xp || 0);
      });

      const sortByStandings = (a: string, b: string) => {
        const aPts = stats[a].wins * 3 + stats[a].draws;
        const bPts = stats[b].wins * 3 + stats[b].draws;
        if (bPts !== aPts) return bPts - aPts;

        const aGd = stats[a].teamGoalsFor - stats[a].teamGoalsConceded;
        const bGd = stats[b].teamGoalsFor - stats[b].teamGoalsConceded;
        if (bGd !== aGd) return bGd - aGd;

        if (stats[b].teamGoalsFor !== stats[a].teamGoalsFor) {
          return stats[b].teamGoalsFor - stats[a].teamGoalsFor;
        }
        if (stats[b].wins !== stats[a].wins) return stats[b].wins - stats[a].wins;

        const aXp = memberXp[a] ?? 0;
        const bXp = memberXp[b] ?? 0;
        if (bXp !== aXp) return bXp - aXp;

        return a.localeCompare(b);
      };

      const leagueTable = [...playerIds].sort(sortByStandings);
      
      const isGoalkeeperRole = (rawRole: unknown) => {
        const role = String(rawRole || '').trim().toLowerCase();
        return role === 'gk' || role.includes('goalkeeper') || role.includes('keeper');
      };

      // Calculate GK-specific stats for Star Keeper
      const gkIds: string[] = (league.members || [])
        .filter((p: any) => isGoalkeeperRole(p.positionType || p.position))
        .map((p: any) => String(p.id));

      const cleanSheets: Record<string, number> = {};
      gkIds.forEach(id => (cleanSheets[id] = 0));

      matchesToUse
        .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
        .forEach((m: any) => {
          const homeGk: string[] = (m.homeTeamUsers || []).filter((u: any) => gkIds.includes(String(u.id))).map((u: any) => String(u.id));
          const awayGk: string[] = (m.awayTeamUsers || []).filter((u: any) => gkIds.includes(String(u.id))).map((u: any) => String(u.id));
          if (Number(m.awayTeamGoals || 0) === 0) homeGk.forEach(id => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
          if (Number(m.homeTeamGoals || 0) === 0) awayGk.forEach(id => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
        });

      // Legendary Shield criteria:
      // lowest average team goals conceded among all players who played.
      const shieldCandidateIds: string[] = playerIds.filter((id: string) => stats[id]?.played > 0);

      const toDisplayName = (row: Record<string, unknown> | null | undefined): string => {
        const r = row || {};
        const full = `${String(r.firstName || '').trim()} ${String(r.lastName || '').trim()}`.trim();
        if (full) return full;
        const alt = String(r.displayName || r.name || r.username || '').trim();
        if (alt) return alt;
        const email = String(r.email || '').trim();
        if (email.includes('@')) return email.split('@')[0];
        return '';
      };

      const nameMap = new Map<string, string>();
      (league.members || []).forEach((p: any) => {
        const pid = String(p.id);
        const nm = toDisplayName(p);
        if (pid && nm) nameMap.set(pid, nm);
      });
      (matchesToUse || []).forEach((m: any) => {
        [...(m.homeTeamUsers || []), ...(m.awayTeamUsers || [])].forEach((u: any) => {
          const pid = String(u.id);
          const nm = toDisplayName(u);
          if (pid && nm && !nameMap.has(pid)) nameMap.set(pid, nm);
        });
      });
      const getPlayerName = (pid: string) => nameMap.get(String(pid)) || '';

      const pickTopBy = (
        ids: string[],
        scorer: (id: string) => number,
        minScore: number = 1
      ): string | null => {
        if (!ids.length) return null;
        const sorted = [...ids].sort((a, b) => scorer(b) - scorer(a));
        const top = sorted[0];
        if (!top) return null;
        return scorer(top) >= minScore ? top : null;
      };

      // Build trophy winners matching frontend expectations
      const awards = [
        { title: 'League Champion', winnerId: leagueTable[0] || null },
        { title: 'Runner-Up', winnerId: leagueTable[1] || null },
        { title: "Ballon D'or", winnerId: pickTopBy(playerIds, (pid) => stats[pid].motmVotes, 1) },
        { title: 'Golden Boot', winnerId: pickTopBy(playerIds, (pid) => stats[pid].goals, 1) },
        { title: 'King Playmaker', winnerId: pickTopBy(playerIds, (pid) => stats[pid].assists, 1) },
        {
          title: 'Legendary Shield',
          winnerId: pickTopBy(playerIds, (pid) => stats[pid].defensiveImpactVotes, 1)
        },
        {
          title: 'Dark Horse',
          winnerId: leagueTable.length > 3
            ? pickTopBy(leagueTable.slice(3), (pid) => stats[pid].motmVotes, 1)
            : null
        },
        {
          title: 'Star Keeper',
          winnerId: (() => {
            const candidates = gkIds.filter(id => stats[id]?.played > 0);
            if (!candidates.length) return null;
            const best = candidates.sort((a, b) => {
              const csA = cleanSheets[a] || 0;
              const csB = cleanSheets[b] || 0;
              if (csB !== csA) return csB - csA;
              const gaA = stats[a]?.teamGoalsConceded ?? Infinity;
              const gaB = stats[b]?.teamGoalsConceded ?? Infinity;
              return gaA - gaB;
            })[0] || null;
            if (!best) return null;
            return (cleanSheets[best] || 0) > 0 ? best : null;
          })()
        }
      ];

      const meetsAwardRequirement = (title: string, winnerId: string | null): boolean => {
        if (!winnerId) return false;
        const s = stats[winnerId];
        if (!s || s.played <= 0) return false;

        switch (title) {
          case 'League Champion':
            return leagueTable.length > 0 && leagueTable[0] === winnerId;
          case 'Runner-Up':
            return leagueTable.length > 1 && leagueTable[1] === winnerId;
          case "Ballon D'or":
            return s.motmVotes > 0;
          case 'Golden Boot':
            return s.goals > 0;
          case 'King Playmaker':
            return s.assists > 0;
          case 'Legendary Shield':
            return s.defensiveImpactVotes > 0;
          case 'Dark Horse':
            return leagueTable.slice(3).includes(winnerId) && s.motmVotes > 0;
          case 'Star Keeper':
            return gkIds.includes(winnerId) && (cleanSheets[winnerId] || 0) > 0;
          default:
            return true;
        }
      };

      const existingSnapshot = hasTrophySnapshotColumn
        ? parseSnapshot(currentSeasonRow?.trophyAwardSnapshot)
        : {};
      const nextSnapshot: TrophySnapshot = { ...existingSnapshot };
      const nowIso = new Date().toISOString();

      awards.forEach((award) => {
        const rawWinnerId = award.winnerId ? String(award.winnerId) : null;
        const winnerId = rawWinnerId && meetsAwardRequirement(award.title, rawWinnerId) ? rawWinnerId : null;
        const prev = existingSnapshot[award.title];
        const winnerName = winnerId ? getPlayerName(winnerId) : '';
        const resolvedWinnerName = winnerId
          ? (winnerName || (prev?.winner && prev.winner !== 'TBC' ? prev.winner : 'Player'))
          : 'TBC';
        const hasValidWinner = Boolean(winnerId);
        const prevWinnerId = prev?.winnerId ? String(prev.winnerId) : null;
        const winnerChanged = (hasValidWinner ? winnerId : null) !== prevWinnerId;

        const awardedAt = hasValidWinner
          ? (hasTrophySnapshotColumn
              ? (winnerChanged
                  ? nowIso
                  : (toIsoString(prev?.awardedAt) || toIsoString(prev?.updatedAt) || nowIso))
              : null)
          : null;
        const updatedAt = hasTrophySnapshotColumn
          ? (winnerChanged ? nowIso : (toIsoString(prev?.updatedAt) || null))
          : null;

        nextSnapshot[award.title] = {
          winnerId: hasValidWinner ? winnerId : null,
          winner: hasValidWinner ? resolvedWinnerName : 'TBC',
          awardedAt,
          updatedAt,
        };

        trophyWinners.push({
          title: award.title,
          winnerId: hasValidWinner ? winnerId : null,
          winner: hasValidWinner ? resolvedWinnerName : 'TBC',
          leagueId: String(league.id),
          leagueName: league.name,
          seasonId: currentSeasonId || undefined,
          seasonName: currentSeasonName || undefined,
          awardedAt,
          updatedAt,
        });
      });

      if (hasTrophySnapshotColumn && currentSeasonRow?.id) {
        const before = comparableSnapshot(existingSnapshot);
        const after = comparableSnapshot(nextSnapshot);
        if (before !== after) {
          seasonSnapshotUpdates.push({
            seasonId: String(currentSeasonRow.id),
            snapshot: nextSnapshot,
          });
        }
      }
    });

    if (hasTrophySnapshotColumn && seasonSnapshotUpdates.length > 0) {
      const latestBySeason = new Map<string, TrophySnapshot>();
      seasonSnapshotUpdates.forEach((row) => {
        latestBySeason.set(row.seasonId, row.snapshot);
      });

      await Promise.all(
        Array.from(latestBySeason.entries()).map(([seasonId, snapshot]) =>
          Season.update(
            { trophyAwardSnapshot: snapshot as any },
            { where: { id: seasonId } }
          )
        )
      );
    }

    console.log(`✅ [Trophy Room] Returning ${trophyWinners.length} trophy winners`);
    
    const winnerUpdateMs = trophyWinners
      .map((row: any) => toIsoString(row.awardedAt) || toIsoString(row.updatedAt))
      .filter((v): v is string => typeof v === 'string')
      .map((iso) => new Date(iso).getTime())
      .filter((ms) => Number.isFinite(ms));
    const lastUpdatedAt = winnerUpdateMs.length > 0 ? new Date(Math.max(...winnerUpdateMs)).toISOString() : null;

    const trPayload = { 
      success: true, 
      trophyWinners,
      backendTotalXP: 0,
      lastUpdatedAt,
    };
    cache.set(trCacheKey, trPayload, 20); // keep short so trophy updates appear quickly
    ctx.body = trPayload;
  } catch (err) {
    console.error('❌ [Trophy Room] Error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch trophy room' };
  }
};

// Get all matches for a specific league (without returning full league payload)
export const getLeagueMatches = async (ctx: Context) => {
  const { id } = ctx.params;
  const requestedSeasonId = typeof ctx.query?.seasonId === 'string' ? ctx.query.seasonId.trim() : '';
  const includeArchived = String(ctx.query?.includeArchived ?? '1') !== '0';
  const all = String(ctx.query?.all ?? '1') === '1';
  const requestedLimit = Number(ctx.query?.limit);
  const requestedPage = Number(ctx.query?.page);

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = String(ctx.state.user.userId);

  try {
    const league = await League.findByPk(id, {
      attributes: ['id', 'name', 'active', 'archived'],
      include: [
        { model: User, as: 'members', attributes: ['id'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        {
          model: Season,
          as: 'seasons',
          attributes: ['id', 'seasonNumber', 'name', 'inviteCode', 'isActive', 'archived'],
          where: { deleted: false },
          required: false,
          include: [
            {
              model: User,
              as: 'players',
              attributes: ['id'],
              through: { attributes: [] }
            }
          ]
        }
      ]
    });

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    const isMember = (league as any).members?.some((m: any) => String(m.id) === userId);
    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === userId);

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    const seasons = (league as any).seasons || [];
    const validSeasonIds = new Set<string>(seasons.map((s: any) => String(s.id)));
    if (requestedSeasonId && !validSeasonIds.has(requestedSeasonId)) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'Invalid seasonId for this league' };
      return;
    }

    const memberSeasonIds = seasons
      .filter((season: any) => {
        const seasonPlayers = season.players || [];
        return seasonPlayers.some((p: any) => String(p.id) === userId);
      })
      .map((season: any) => String(season.id));

    if (!isAdmin && requestedSeasonId && !memberSeasonIds.includes(requestedSeasonId)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied for requested season' };
      return;
    }

    const whereClause: Record<string, unknown> = { leagueId: id, deleted: false };
    if (!includeArchived) {
      whereClause.archived = false;
    }

    if (requestedSeasonId) {
      whereClause.seasonId = requestedSeasonId;
    } else if (!isAdmin) {
      // Member can only see matches for seasons where they are enrolled.
      if (memberSeasonIds.length === 0) {
        ctx.body = {
          success: true,
          page: 1,
          limit: 0,
          total: 0,
          totalPages: 0,
          matches: [],
          leagueMatches: [],
          league: {
            id: league.id,
            name: league.name,
            active: (league as any).active,
            archived: Boolean((league as any).archived),
            isAdmin
          }
        };
        return;
      }
      whereClause.seasonId = { [Op.in]: memberSeasonIds };
    }

    const matches = await Match.findAll({
      where: whereClause as any,
      attributes: { exclude: [] },
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] },
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
        { model: User, as: 'availableUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'], through: { attributes: [] } },
        { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'firstName', 'lastName', 'team'] },
        { model: Vote, as: 'votes', attributes: ['voterId', 'votedForId'] }
      ],
      order: [['date', 'ASC'], ['createdAt', 'ASC']]
    });

    const matchesBySeasonMap: Record<string, any[]> = {};
    matches.forEach((match: any) => {
      const seasonId = String(match.seasonId || 'no-season');
      if (!matchesBySeasonMap[seasonId]) {
        matchesBySeasonMap[seasonId] = [];
      }
      matchesBySeasonMap[seasonId].push(match);
    });

    const matchesWithNumbers: any[] = [];
    Object.keys(matchesBySeasonMap).forEach((seasonId) => {
      const seasonMatches = matchesBySeasonMap[seasonId]
        .sort((a: any, b: any) => {
          const dateA = new Date(a.date || a.createdAt).getTime();
          const dateB = new Date(b.date || b.createdAt).getTime();
          return dateA - dateB;
        })
        .map((match: any, index: number) => {
          const matchJson = match.toJSON();
          const guests = Array.isArray(matchJson.guestPlayers) ? matchJson.guestPlayers : [];

          const manOfTheMatchVotes: Record<string, string> = {};
          if (Array.isArray(matchJson.votes)) {
            matchJson.votes.forEach((vote: any) => {
              manOfTheMatchVotes[vote.voterId] = vote.votedForId;
            });
          }
          delete matchJson.votes;
          delete matchJson.guestPlayers;

          return {
            ...matchJson,
            seasonMatchNumber: index + 1,
            matchNumber: index + 1,
            manOfTheMatchVotes,
            guests,
          };
        });

      matchesWithNumbers.push(...seasonMatches);
    });

    const MAX_LIMIT = 500;
    const DEFAULT_LIMIT = 200;
    const normalizedLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    const total = matchesWithNumbers.length;
    const totalPages = total > 0 ? Math.ceil(total / normalizedLimit) : 0;
    const start = (page - 1) * normalizedLimit;
    const pagedMatches = all ? matchesWithNumbers : matchesWithNumbers.slice(start, start + normalizedLimit);

    ctx.body = {
      success: true,
      page: all ? 1 : page,
      limit: all ? total : normalizedLimit,
      total,
      totalPages: all ? (total > 0 ? 1 : 0) : totalPages,
      matches: pagedMatches,
      leagueMatches: pagedMatches,
      league: {
        id: league.id,
        name: league.name,
        active: (league as any).active,
        archived: Boolean((league as any).archived),
        isAdmin
      }
    };
  } catch (err) {
    console.error('Get league matches error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch league matches' };
  }
};

// Get a specific match from a league
export const getLeagueMatch = async (ctx: Context) => {
  const { id, matchId } = ctx.params;
  try {
    const match = await Match.findOne({
      where: { id: matchId, leagueId: id },
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] },
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'firstName', 'lastName', 'shirtNumber', 'team'] }
      ]
    });

    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found in this league' };
      return;
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        leagueId: match.leagueId,
        seasonId: match.seasonId,
        date: match.date,
        start: match.start,
        end: match.end,
        location: match.location,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        homeTeamImage: match.homeTeamImage,
        awayTeamImage: match.awayTeamImage,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        homeCaptainId: match.homeCaptainId,
        awayCaptainId: match.awayCaptainId,
        status: normalizeStatus(match.status),
        league: (match as any).league,
        homeTeamUsers: (match as any).homeTeamUsers || [],
        awayTeamUsers: (match as any).awayTeamUsers || [],
        guests: (match as any).guestPlayers || []
      }
    };
  } catch (err) {
    console.error('Get league match error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch match' };
  }
};

// ── Team-view endpoint for the pitch formation screen ────────────────────
export const getTeamView = async (ctx: Context) => {
  const { id, matchId } = ctx.params;
  try {
    const match = await Match.findOne({
      where: { id: matchId, leagueId: id },
      include: [
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'firstName', 'lastName', 'shirtNumber', 'team'] },
      ],
    });

    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    // Map users → shape the client expects (role instead of position)
    const homeUsers = ((match as any).homeTeamUsers || []);
    const awayUsers = ((match as any).awayTeamUsers || []);
    const teamUserIds = Array.from(new Set([
      ...homeUsers.map((u: any) => String(u.id)),
      ...awayUsers.map((u: any) => String(u.id)),
    ].filter(Boolean)));

    // ROOT FIX: Team-view should return per-match XP (match_statistics.xp_awarded)
    const xpByUserId: Record<string, number> = {};
    if (teamUserIds.length > 0) {
      try {
        const placeholders = teamUserIds.map((_, i) => `$${i + 2}`).join(',');
        const xpRows = await MatchStatistics.sequelize!.query<{
          user_id?: string;
          userId?: string;
          xp_awarded?: number;
          xpAwarded?: number;
        }>(
          `SELECT user_id, xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id IN (${placeholders})`,
          { bind: [matchId, ...teamUserIds], type: QueryTypes.SELECT }
        );
        xpRows.forEach((r) => {
          const uid = String(r.user_id ?? r.userId ?? '').trim();
          if (!uid) return;
          const raw = r.xp_awarded ?? r.xpAwarded ?? 0;
          const xp = Number(raw);
          xpByUserId[uid] = Number.isFinite(xp) ? xp : 0;
        });
      } catch (xpErr) {
        console.warn('[getTeamView] Failed to load match XP, defaulting to 0:', xpErr);
      }
    }

    const mapUser = (u: any) => {
      const uid = String(u.id);
      return {
        id: uid,
        firstName: u.firstName,
        lastName: u.lastName,
        shirtNumber: u.shirtNumber || null,
        role: u.position || null,
        xp: xpByUserId[uid] ?? 0,
      };
    };

    const homeTeam = homeUsers.map(mapUser);
    const awayTeam = awayUsers.map(mapUser);
    let guests = ((match as any).guestPlayers  || []).map((g: any) => ({
      id: String(g.id),
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber || null,
      team: normalizeTeam(g.team),
    }));

    // Load saved pitch positions
    let positions: { home: Record<string, { x: number; y: number }>; away: Record<string, { x: number; y: number }> } = { home: {}, away: {} };
    try {
      // Ensure table exists before querying
      await MatchPlayerLayout.sequelize!.query(`
        CREATE TABLE IF NOT EXISTS match_player_layouts (
          "matchId" VARCHAR(255) NOT NULL,
          "userId" VARCHAR(255) NOT NULL,
          team VARCHAR(10) NOT NULL,
          x FLOAT NOT NULL,
          y FLOAT NOT NULL,
          "createdAt" TIMESTAMPTZ DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY ("matchId","userId")
        );
      `);
      const layouts = await MatchPlayerLayout.findAll({ where: { matchId } });
      console.log(`[getTeamView] Loaded ${layouts.length} layout positions for match ${matchId}`);
      for (const l of layouts) {
        const side = l.team === 'away' ? 'away' : 'home';
        positions[side][String(l.userId)] = { x: l.x, y: l.y };
      }

      // Prefer saved layout side for guests when available.
      const homeLayoutIds = new Set(Object.keys(positions.home).map(String));
      const awayLayoutIds = new Set(Object.keys(positions.away).map(String));
      guests = guests.map((g: any) => {
        if (homeLayoutIds.has(String(g.id))) return { ...g, team: 'home' };
        if (awayLayoutIds.has(String(g.id))) return { ...g, team: 'away' };
        return g;
      });
    } catch (posErr) {
      console.error('[getTeamView] Failed to load positions:', posErr);
    }

    // Removed players from match JSON column
    const removed = (match as any).removed || { home: [], away: [] };

    ctx.body = {
      success: true,
      match: {
        homeTeamName: match.homeTeamName || 'Home',
        awayTeamName: match.awayTeamName || 'Away',
        status: normalizeStatus(match.status),
        homeCaptainId: match.homeCaptainId || null,
        awayCaptainId: match.awayCaptainId || null,
        homeTeamGoals: match.homeTeamGoals ?? null,
        awayTeamGoals: match.awayTeamGoals ?? null,
        homeTeam,
        awayTeam,
        guests,
        positions,
        removed,
      },
    };
  } catch (err) {
    console.error('getTeamView error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to load team view' };
  }
};

// ── Save pitch layout positions ──────────────────────────────────────────
export const saveLayout = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { team, positions } = ctx.request.body as { team?: string; positions?: Record<string, { x: number; y: number }> };

  if (!team || !positions || typeof positions !== 'object') {
    ctx.status = 400;
    ctx.body = { success: false, message: 'team and positions required' };
    return;
  }

  const side = team === 'away' ? 'away' : 'home';

  try {
    const actorId = String(ctx.state.user?.userId || '');
    if (!actorId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const permissionMatch = await getMatchTeamManagementContext(matchId);
    if (!permissionMatch) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    if (!hasTeamManagementPermission(permissionMatch, actorId, side)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only league admins or team captains can update formation.' };
      return;
    }

    const sequelizeInstance = MatchPlayerLayout.sequelize!;

    // Ensure table exists (createIfNotExists)
    await sequelizeInstance.query(`
      CREATE TABLE IF NOT EXISTS match_player_layouts (
        "matchId" VARCHAR(255) NOT NULL,
        "userId" VARCHAR(255) NOT NULL,
        team VARCHAR(10) NOT NULL,
        x FLOAT NOT NULL,
        y FLOAT NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY ("matchId","userId")
      );
    `);

    const clamp01 = (n: unknown) => Math.max(0.04, Math.min(0.96, Number(n) || 0));
    const centerGap = 0.02;

    // Upsert each player position
    for (const [userId, pos] of Object.entries(positions)) {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        const x = clamp01(pos.x);
        let y = clamp01(pos.y);
        y = side === 'home'
          ? Math.min(0.5 - centerGap, y)
          : Math.max(0.5 + centerGap, y);
        await MatchPlayerLayout.upsert({ matchId, userId, team: side, x, y });
      }
    }

    ctx.body = { success: true };
  } catch (err) {
    console.error('saveLayout error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to save layout' };
  }
};

// ── Remove player from match team ────────────────────────────────────────
export const removePlayerFromTeam = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { team, userId } = ctx.request.body as { team?: string; userId?: string };
  if (!team || !userId) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'team and userId required' };
    return;
  }
  const side = team === 'away' ? 'away' : 'home';

  try {
    const actorId = String(ctx.state.user?.userId || '');
    if (!actorId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const match = await getMatchTeamManagementContext(matchId);
    if (!match) { ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return; }

    if (!hasTeamManagementPermission(match, actorId, side)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only league admins or team captains can move players.' };
      return;
    }

    const removed: { home: string[]; away: string[] } = (match as any).removed || { home: [], away: [] };
    if (!removed[side].includes(String(userId))) {
      removed[side].push(String(userId));
    }
    await match.update({ removed } as any);
    ctx.body = { success: true, removed };
  } catch (err) {
    console.error('removePlayerFromTeam error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to remove player' };
  }
};

// ── Make captain ─────────────────────────────────────────────────────────
export const makeCaptain = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { team, userId } = ctx.request.body as { team?: string; userId?: string };
  if (!team || !userId) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'team and userId required' };
    return;
  }

  try {
    const actorId = String(ctx.state.user?.userId || '');
    if (!actorId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const side = team === 'away' ? 'away' : 'home';
    const match = await getMatchTeamManagementContext(matchId);
    if (!match) { ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return; }

    if (!hasTeamManagementPermission(match, actorId, side)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only league admins or team captains can assign captains.' };
      return;
    }

    const field = side === 'away' ? 'awayCaptainId' : 'homeCaptainId';
    await match.update({ [field]: userId } as any);
    ctx.body = { success: true };
  } catch (err) {
    console.error('makeCaptain error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to set captain' };
  }
};

// ── Switch player between teams ──────────────────────────────────────────
export const switchPlayerTeam = async (ctx: Context) => {
  const { id, matchId } = ctx.params;
  const { userId, from } = ctx.request.body as { userId?: string; from?: string };
  if (!userId || !from) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'userId and from required' };
    return;
  }
  const fromSide = from === 'away' ? 'away' : 'home';
  const toSide = fromSide === 'home' ? 'away' : 'home';

  try {
    const actorId = String(ctx.state.user?.userId || '');
    if (!actorId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const match = await getMatchTeamManagementContext(matchId);
    if (!match || String((match as any).leagueId) !== String(id)) { ctx.status = 404; ctx.body = { success: false }; return; }

    if (!hasTeamManagementPermission(match, actorId, fromSide)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only league admins or team captains can move players.' };
      return;
    }

    const sequelizeInst = Match.sequelize!;
    const homeJoin = 'MatchHomeTeamUsers';
    const awayJoin = 'MatchAwayTeamUsers';
    const removeTable = fromSide === 'home' ? homeJoin : awayJoin;
    const addTable = toSide === 'home' ? homeJoin : awayJoin;

    // Remove from current team
    await sequelizeInst.query(
      `DELETE FROM "${removeTable}" WHERE "matchId" = :matchId AND "userId" = :userId`,
      { replacements: { matchId, userId }, type: QueryTypes.DELETE }
    );
    // Add to other team
    await sequelizeInst.query(
      `INSERT INTO "${addTable}" ("matchId","userId","createdAt","updatedAt") VALUES (:matchId, :userId, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      { replacements: { matchId, userId }, type: QueryTypes.INSERT }
    );

    ctx.body = { success: true };
  } catch (err) {
    console.error('switchPlayerTeam error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to switch player' };
  }
};

// ── Replace player (remove one, add another) ─────────────────────────────
export const replacePlayer = async (ctx: Context) => {
  const { id, matchId } = ctx.params;
  const { team, removedId, replacementId } = ctx.request.body as { team?: string; removedId?: string; replacementId?: string };
  if (!team || !removedId || !replacementId) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'team, removedId and replacementId required' };
    return;
  }
  const side = team === 'away' ? 'away' : 'home';
  const joinTable = side === 'home' ? 'MatchHomeTeamUsers' : 'MatchAwayTeamUsers';

  try {
    const actorId = String(ctx.state.user?.userId || '');
    if (!actorId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const match = await getMatchTeamManagementContext(matchId);
    if (!match || String((match as any).leagueId) !== String(id)) { ctx.status = 404; ctx.body = { success: false }; return; }

    if (!hasTeamManagementPermission(match, actorId, side)) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only league admins or team captains can move players.' };
      return;
    }

    const sequelizeInst = Match.sequelize!;

    // Remove old player from join table
    await sequelizeInst.query(
      `DELETE FROM "${joinTable}" WHERE "matchId" = :matchId AND "userId" = :removedId`,
      { replacements: { matchId, removedId }, type: QueryTypes.DELETE }
    );
    // Add replacement
    await sequelizeInst.query(
      `INSERT INTO "${joinTable}" ("matchId","userId","createdAt","updatedAt") VALUES (:matchId, :replacementId, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      { replacements: { matchId, replacementId }, type: QueryTypes.INSERT }
    );

    // Mark old player as removed in JSON
    const removed: { home: string[]; away: string[] } = (match as any).removed || { home: [], away: [] };
    if (!removed[side].includes(String(removedId))) {
      removed[side].push(String(removedId));
    }
    await match.update({ removed } as any);

    ctx.body = { success: true };
  } catch (err) {
    console.error('replacePlayer error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to replace player' };
  }
};

// Get match availability for a specific match in league
export const getMatchAvailability = async (ctx: Context) => {
  const { leagueId, matchId } = ctx.params;
  try {
    const availability = await MatchAvailability.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'userRecord', attributes: ['id', 'firstName', 'lastName', 'profilePicture'] }]
    });

    ctx.body = {
      success: true,
      availability: availability.map(a => ({
        userId: a.user_id,
        available: a.status === 'available',
        user: (a as any).userRecord
      })),
      availableUserIds: availability
        .filter(a => a.status === 'available')
        .map(a => a.user_id)
    };
  } catch (err) {
    console.error('Get match availability error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch availability' };
  }
};

// Get user leagues
export const getUserLeagues = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `user_leagues_${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    const leaguesBasic = await fetchUserLeaguesBasic(String(userId));
    const completionByLeague = await checkLeagueCompletionBulk(leaguesBasic.map((league) => league.id));

    const result = {
      success: true,
      leagues: leaguesBasic.map((league) => {
        const completionInfo = completionByLeague[league.id];
        const lifecycle = deriveLeagueLifecycle(
          league.active,
          league.archived,
          completionInfo?.isCompleted,
          false
        );
        return {
          id: league.id,
          name: league.name,
          active: league.active,
          archived: league.archived,
          image: league.image,
          maxGames: league.maxGames,
          status: lifecycle.status,
          createdAt: league.createdAt,
          isComplete: lifecycle.isComplete,
          isCompleted: lifecycle.isCompleted,
          isLocked: lifecycle.isLocked,
          computedStatus: {
            isCompleted: lifecycle.isCompleted,
            isComplete: lifecycle.isComplete,
            locked: lifecycle.locked,
            activeSeasonCompleted: Boolean(completionInfo?.activeSeasonCompleted),
            allStatsSubmitted: Boolean(completionInfo?.allStatsSubmitted),
            matchesPlayed: completionInfo?.totalCompletedMatches ?? 0,
            gamesPlayed: completionInfo?.totalCompletedMatches ?? 0,
            maxGames: league.maxGames ?? 0,
            totalMaxGames: completionInfo?.totalMaxGames ?? 0,
            missing: completionInfo?.missing ?? [],
            seasons: (completionInfo?.seasons ?? []).map(s => ({
              seasonId: s.seasonId,
              seasonName: s.seasonName,
              maxGames: s.maxGames,
              completedMatches: s.completedMatches,
              isCompleted: s.isCompleted,
              last2MatchesStatsComplete: s.last2MatchesStatsComplete,
              missingStatsPlayers: s.missingStatsPlayers,
            })),
          },
        };
      })
    };

    cache.set(cacheKey, result, 120); // Reduced cache time for more accurate completion status
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (err) {
    console.error('Get user leagues error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch leagues' };
  }
};

// Get league by ID
export const getLeagueById = async (ctx: Context) => {
  const { id } = ctx.params;
  const requestedSeasonId = typeof ctx.query?.seasonId === 'string' ? ctx.query.seasonId.trim() : '';
  const includeMatches = String(ctx.query?.includeMatches ?? '1') !== '0';

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `league_${id}_${userId}_${requestedSeasonId || 'all'}_${includeMatches ? 'with_matches' : 'meta'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    const league = await League.findByPk(id, {
      attributes: ['id', 'name', 'inviteCode', 'active', 'archived', 'image', 'maxGames', 'createdAt', 'updatedAt']
    });

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    const [members, administeredLeagues, seasons] = await Promise.all([
      User.findAll({
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber', 'style'],
        include: [
          {
            model: League,
            as: 'leagues',
            attributes: [],
            through: { attributes: [] },
            where: { id },
            required: true,
          }
        ]
      }),
      User.findAll({
        attributes: ['id'],
        include: [
          {
            model: League,
            as: 'administeredLeagues',
            attributes: [],
            through: { attributes: [] },
            where: { id },
            required: true,
          }
        ]
      }),
      Season.findAll({
        where: { leagueId: id, deleted: false },
        attributes: ['id', 'seasonNumber', 'name', 'inviteCode', 'isActive', 'archived', 'startDate', 'endDate', 'maxGames', 'showPoints', 'createdAt', 'updatedAt'],
        include: [
          {
            model: User,
            as: 'players',
            attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber', 'style'],
            through: { attributes: [] }
          }
        ],
        order: [['seasonNumber', 'DESC'], ['createdAt', 'DESC']]
      })
    ]);

    const isMember = members.some((m: any) => String(m.id) === String(userId));
    const isAdmin = administeredLeagues.some((a: any) => String(a.id) === String(userId));

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    const membersJson = members.map((m: any) => m.toJSON());
    const adminsJson = administeredLeagues.map((a: any) => a.toJSON());
    const validSeasonIds = new Set<string>(seasons.map((s: any) => String(s.id)));
    if (requestedSeasonId && !validSeasonIds.has(requestedSeasonId)) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'Invalid seasonId for this league' };
      return;
    }
    let userSeasonId: string | null = null;

    // Fast path for callers that only need league metadata (name/admin/members/seasons).
    // Skips heavy match/vote/availability queries.
    if (!includeMatches) {
      if (isAdmin) {
        const adminSeasons = requestedSeasonId
          ? seasons.filter((s: any) => String(s.id) === requestedSeasonId)
          : seasons;
        const formattedSeasons = adminSeasons.map((season: any) => ({
          ...season.toJSON(),
          members: season.players || []
        }));
        const currentSeason = formattedSeasons.find((s: any) => s.isActive) || (formattedSeasons[0] || null);

        ctx.body = {
          success: true,
          league: {
            id: league.id,
            name: league.name,
            inviteCode: (currentSeason as any)?.inviteCode || league.inviteCode,
            active: league.active,
            archived: Boolean((league as any).archived),
            image: (league as any).image,
            maxGames: league.maxGames,
            createdAt: league.createdAt,
            updatedAt: league.updatedAt,
            members: membersJson,
            matches: [],
            seasons: formattedSeasons,
            currentSeason,
            administrators: adminsJson,
            isAdmin
          }
        };
        cache.set(cacheKey, ctx.body, 12);
        ctx.set('X-Cache', 'MISS');
        return;
      }

      const memberSeasons = seasons.filter((season: any) => {
        const seasonPlayers = season.players || [];
        return seasonPlayers.some((p: any) => String(p.id) === String(userId));
      });

      if (requestedSeasonId && !memberSeasons.some((s: any) => String(s.id) === requestedSeasonId)) {
        ctx.status = 403;
        ctx.body = { success: false, message: 'Access denied for requested season' };
        return;
      }

      const visibleSeasons = requestedSeasonId
        ? memberSeasons.filter((s: any) => String(s.id) === requestedSeasonId)
        : memberSeasons;

      const formattedSeasons = [...visibleSeasons]
        .sort((a: any, b: any) => (b.seasonNumber || 0) - (a.seasonNumber || 0))
        .map((season: any) => ({
          ...season.toJSON(),
          members: season.players || []
        }));

      const currentSeason = formattedSeasons[0] || null;

      ctx.body = {
        success: true,
        league: {
          id: league.id,
          name: league.name,
          inviteCode: (currentSeason as any)?.inviteCode || league.inviteCode,
          active: league.active,
          archived: Boolean((league as any).archived),
          image: (league as any).image,
          maxGames: league.maxGames,
          createdAt: league.createdAt,
          updatedAt: league.updatedAt,
          members: membersJson,
          matches: [],
          seasons: formattedSeasons,
          currentSeason,
          administrators: adminsJson,
          isAdmin
        }
      };
      cache.set(cacheKey, ctx.body, 12);
      ctx.set('X-Cache', 'MISS');
      return;
    }

    // If user is ADMIN - show ALL seasons and ALL matches (frontend will filter)
    if (isAdmin) {
      const activeSeason = seasons.find((s: any) => s.isActive);
      userSeasonId = activeSeason?.id || (seasons.length > 0 ? seasons[0].id : null);

      // Fetch ALL matches for ALL seasons (admin can switch between seasons in frontend)
      const { Vote } = await importWithFallback('../models/Vote.js');
      const matches = await Match.findAll({
        where: {
          leagueId: id,
          deleted: false,
          ...(requestedSeasonId ? { seasonId: requestedSeasonId } : {})
        },
        attributes: { exclude: [] },
        include: [
          { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
          { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
          { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'firstName', 'lastName', 'team'] },
          { model: Vote, as: 'votes', attributes: ['voterId', 'votedForId'] }
        ],
        order: [['createdAt', 'ASC']] // Order by creation date to assign matchNumber
      });

      console.log(`📊 [ADMIN] Fetching ALL matches for league ${id}: ${matches.length} matches`);
      matches.forEach((m: any) => {
        console.log(`   - ${m.homeTeamName} vs ${m.awayTeamName} | seasonId: ${m.seasonId}`);
      });

      // Fetch availability data for all matches in this league
      const matchIds = matches.map((m: any) => m.id);
      const availabilityRecords = await MatchAvailability.findAll({
        where: {
          match_id: matchIds,
          status: 'available' // Only get users who are AVAILABLE
        }
      });

      // Get all user IDs who are available
      const availableUserIds = [...new Set(availabilityRecords.map((a: any) => a.user_id))];
      const availableUsersData = await User.findAll({
        where: { id: availableUserIds },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture']
      });

      // Create a map of userId -> user data
      const userMap = new Map(availableUsersData.map((u: any) => [u.id, u.toJSON()]));

      // Create a map of matchId -> available users
      const matchAvailabilityMap: Record<string, any[]> = {};
      availabilityRecords.forEach((a: any) => {
        if (!matchAvailabilityMap[a.match_id]) {
          matchAvailabilityMap[a.match_id] = [];
        }
        const userData = userMap.get(a.user_id);
        if (userData) {
          matchAvailabilityMap[a.match_id].push(userData);
        }
      });

      // Group matches by seasonId and assign seasonMatchNumber
      const matchesBySeasonMap: Record<string, any[]> = {};
      matches.forEach((match: any) => {
        const seasonId = match.seasonId || 'no-season';
        if (!matchesBySeasonMap[seasonId]) {
          matchesBySeasonMap[seasonId] = [];
        }
        matchesBySeasonMap[seasonId].push(match);
      });

      // Sort matches within each season by date and assign seasonMatchNumber
      const matchesWithNumbers: any[] = [];
      Object.keys(matchesBySeasonMap).forEach(seasonId => {
        const seasonMatches = matchesBySeasonMap[seasonId]
          .sort((a: any, b: any) => {
            const dateA = new Date(a.date || a.createdAt).getTime();
            const dateB = new Date(b.date || b.createdAt).getTime();
            return dateA - dateB; // Ascending order (oldest first)
          })
          .map((match: any, index: number) => {
            const matchJson = match.toJSON();
            const guests = Array.isArray(matchJson.guestPlayers) ? matchJson.guestPlayers : [];
            
            // Convert votes array to manOfTheMatchVotes object format
            const manOfTheMatchVotes: Record<string, string> = {};
            if (matchJson.votes && Array.isArray(matchJson.votes)) {
              matchJson.votes.forEach((vote: any) => {
                manOfTheMatchVotes[vote.voterId] = vote.votedForId;
              });
            }
            delete matchJson.votes; // Remove votes array
            delete matchJson.guestPlayers; // Normalize key for frontend
            
            return {
              ...matchJson,
              seasonMatchNumber: index + 1, // Season-specific match number
              matchNumber: index + 1, // Keep for backward compatibility
              manOfTheMatchVotes,
              guests,
              availableUsers: matchAvailabilityMap[match.id] || []
            };
          });
        
        matchesWithNumbers.push(...seasonMatches);
      });

      // Format seasons with members instead of players for frontend compatibility
      const formattedSeasons = seasons.map((season: any) => ({
        ...season.toJSON(),
        members: season.players || [] // Rename 'players' to 'members' for frontend
      }));

      console.log('📊 [ADMIN] Returning league data:');
      console.log(`   - League: ${league.name}`);
      console.log(`   - Total seasons: ${formattedSeasons.length}`);
      formattedSeasons.forEach((s: any) => {
        console.log(`   - Season ${s.seasonNumber}: ${s.members?.length || 0} members`);
      });

      // Compute league/season completion status
      const completionInfo = await checkLeagueCompletion(String(league.id));
      const computedStatus = {
        isCompleted: completionInfo.isCompleted,
        isComplete: completionInfo.isCompleted,
        locked: completionInfo.isCompleted,
        activeSeasonCompleted: completionInfo.activeSeasonCompleted,
        allStatsSubmitted: completionInfo.allStatsSubmitted,
        totalCompletedMatches: completionInfo.totalCompletedMatches,
        totalMaxGames: completionInfo.totalMaxGames,
        maxGames: league.maxGames,
        matchesPlayed: completionInfo.totalCompletedMatches,
        gamesPlayed: completionInfo.totalCompletedMatches,
        seasons: completionInfo.seasons.map(s => ({
          seasonId: s.seasonId,
          seasonNumber: s.seasonNumber,
          seasonName: s.seasonName,
          isActive: s.isActive,
          maxGames: s.maxGames,
          completedMatches: s.completedMatches,
          isCompleted: s.isCompleted,
          last2MatchesStatsComplete: s.last2MatchesStatsComplete,
          missingStatsPlayers: s.missingStatsPlayers,
        })),
        missing: completionInfo.missing,
      };
      const lifecycle = deriveLeagueLifecycle(
        Boolean(league.active),
        Boolean((league as any).archived),
        completionInfo.isCompleted,
        completionInfo.isCompleted
      );

      ctx.body = {
        success: true,
        league: {
          id: league.id,
          name: league.name,
          inviteCode: ((activeSeason || (seasons.length > 0 ? seasons[0] : null)) as any)?.inviteCode || league.inviteCode,
          active: league.active,
          archived: Boolean((league as any).archived),
          image: (league as any).image,
          maxGames: league.maxGames,
          createdAt: league.createdAt,
          updatedAt: league.updatedAt,
          status: lifecycle.status,
          isComplete: lifecycle.isComplete,
          isCompleted: lifecycle.isCompleted,
          isLocked: lifecycle.isLocked,
          members: membersJson,
          matches: matchesWithNumbers,
          seasons: formattedSeasons, // Admin sees ALL seasons with members
          currentSeason: activeSeason || (seasons.length > 0 ? seasons[0] : null), // Admin's current = active season
          administrators: adminsJson,
          isAdmin,
          computedStatus
        }
      };
      cache.set(cacheKey, ctx.body, 8);
      ctx.set('X-Cache', 'MISS');
      return;
    }

    // For non-admin members - find their LATEST/HIGHEST season
    // Sort seasons by seasonNumber DESC to find highest first
    const sortedSeasons = [...seasons].sort((a: any, b: any) => (b.seasonNumber || 0) - (a.seasonNumber || 0));
    
    // Find user's highest season number they are a member of
    for (const season of sortedSeasons) {
      const seasonPlayers = season.players || [];
      if (seasonPlayers.some((p: any) => String(p.id) === String(userId))) {
        userSeasonId = season.id;
        console.log(`📌 User ${userId} found in season ${season.seasonNumber} (id: ${season.id})`);
        break;
      }
    }

    // If user is not in any season, check if they declined the active season
    if (!userSeasonId) {
      const Notification = (await importWithFallback('../models/Notification.js')).default as any;
      const activeSeason = seasons.find((s: any) => s.isActive);
      
      if (activeSeason) {
        const declinedNotification = await Notification.findOne({
          where: {
            user_id: userId,
            type: 'NEW_SEASON',
            meta: {
              seasonId: activeSeason.id,
              actionTaken: 'declined'
            }
          }
        });

        // User hasn't joined the new season yet (either declined or no response)
        // Show them the previous season
        const previousSeason = seasons.find((s: any) => 
          s.seasonNumber === activeSeason.seasonNumber - 1
        );
        if (previousSeason) {
          userSeasonId = previousSeason.id;
        }
      }
    }

    // Fetch ALL matches for seasons user is a member of (frontend will filter by selected season)
    const { Vote } = await importWithFallback('../models/Vote.js');
    
    // Get all season IDs user is a member of
    const userSeasonIds = seasons
      .filter((s: any) => {
        const seasonPlayers = s.players || [];
        return seasonPlayers.some((p: any) => String(p.id) === String(userId));
      })
      .map((s: any) => s.id);

    const selectedMemberSeasonId =
      requestedSeasonId && userSeasonIds.some((sid: string) => String(sid) === requestedSeasonId)
        ? requestedSeasonId
        : null;

    if (requestedSeasonId && !selectedMemberSeasonId) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied for requested season' };
      return;
    }

    if (selectedMemberSeasonId) {
      userSeasonId = selectedMemberSeasonId;
    }
    
    console.log(`📊 [MEMBER] User ${userId} is in seasons:`, userSeasonIds);
    
    const matchWhere: any = {
      leagueId: id,
      deleted: false,
    };
    if (selectedMemberSeasonId) {
      matchWhere.seasonId = selectedMemberSeasonId;
    } else if (userSeasonIds.length > 0) {
      matchWhere.seasonId = userSeasonIds; // Fetch matches for all user's seasons
    } else {
      matchWhere.id = { [Op.is]: null };
    }

    const matches = await Match.findAll({
      where: matchWhere,
      attributes: { exclude: [] },
      include: [
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber'] },
        { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'firstName', 'lastName', 'team'] },
        { model: Vote, as: 'votes', attributes: ['voterId', 'votedForId'] }
      ],
      order: [['createdAt', 'ASC']] // Order by creation date to assign matchNumber
    });
    
    console.log(`📊 [MEMBER] Fetching matches for user's seasons: ${matches.length} matches`);
    matches.forEach((m: any) => {
      console.log(`   - ${m.homeTeamName} vs ${m.awayTeamName} | seasonId: ${m.seasonId}`);
    });

    // Fetch availability data for all matches
    const matchIds = matches.map((m: any) => m.id);
    const availabilityRecords = await MatchAvailability.findAll({
      where: {
        match_id: matchIds,
        status: 'available' // Only get users who are AVAILABLE
      }
    });

    // Get all user IDs who are available
    const availableUserIds = [...new Set(availabilityRecords.map((a: any) => a.user_id))];
    const availableUsersData = await User.findAll({
      where: { id: availableUserIds },
      attributes: ['id', 'firstName', 'lastName', 'profilePicture']
    });

    // Create a map of userId -> user data
    const userMap = new Map(availableUsersData.map((u: any) => [u.id, u.toJSON()]));

    // Create a map of matchId -> available users
    const matchAvailabilityMap: Record<string, any[]> = {};
    availabilityRecords.forEach((a: any) => {
      if (!matchAvailabilityMap[a.match_id]) {
        matchAvailabilityMap[a.match_id] = [];
      }
      const userData = userMap.get(a.user_id);
      if (userData) {
        matchAvailabilityMap[a.match_id].push(userData);
      }
    });

    // Group matches by seasonId and assign seasonMatchNumber
    const matchesBySeasonMap: Record<string, any[]> = {};
    matches.forEach((match: any) => {
      const seasonId = match.seasonId || 'no-season';
      if (!matchesBySeasonMap[seasonId]) {
        matchesBySeasonMap[seasonId] = [];
      }
      matchesBySeasonMap[seasonId].push(match);
    });

    // Sort matches within each season by date and assign seasonMatchNumber
    const matchesWithNumbers: any[] = [];
    Object.keys(matchesBySeasonMap).forEach(seasonId => {
      const seasonMatches = matchesBySeasonMap[seasonId]
        .sort((a: any, b: any) => {
          const dateA = new Date(a.date || a.createdAt).getTime();
          const dateB = new Date(b.date || b.createdAt).getTime();
          return dateA - dateB; // Ascending order (oldest first)
        })
        .map((match: any, index: number) => {
          const matchJson = match.toJSON();
          const guests = Array.isArray(matchJson.guestPlayers) ? matchJson.guestPlayers : [];
          
          // Convert votes array to manOfTheMatchVotes object format
          const manOfTheMatchVotes: Record<string, string> = {};
          if (matchJson.votes && Array.isArray(matchJson.votes)) {
            matchJson.votes.forEach((vote: any) => {
              manOfTheMatchVotes[vote.voterId] = vote.votedForId;
            });
          }
          delete matchJson.votes; // Remove votes array
          delete matchJson.guestPlayers; // Normalize key for frontend
          
          return {
            ...matchJson,
            seasonMatchNumber: index + 1, // Season-specific match number
            matchNumber: index + 1, // Keep for backward compatibility
            manOfTheMatchVotes,
            guests,
            availableUsers: matchAvailabilityMap[match.id] || []
          };
        });
      
      matchesWithNumbers.push(...seasonMatches);
    });

    // Filter seasons - only show seasons where user is a member, sorted by seasonNumber DESC
    const filteredSeasons = seasons
      .filter((season: any) => {
        const seasonPlayers = season.players || [];
        return seasonPlayers.some((p: any) => String(p.id) === String(userId));
      })
      .sort((a: any, b: any) => (b.seasonNumber || 0) - (a.seasonNumber || 0))
      .map((season: any) => ({
        ...season.toJSON(),
        members: season.players || [] // Rename 'players' to 'members' for frontend
      }));

    // Get the user's current season (highest season they are in)
    const userCurrentSeason = filteredSeasons.find((s: any) => s.id === userSeasonId) || 
                              (filteredSeasons.length > 0 ? filteredSeasons[0] : null);
    
    console.log(`📊 [MEMBER] User ${userId} - filteredSeasons: ${filteredSeasons.map((s: any) => s.seasonNumber).join(', ')}, currentSeason: ${userCurrentSeason?.seasonNumber}`);
    filteredSeasons.forEach((s: any) => {
      console.log(`   - Season ${s.seasonNumber}: ${s.members?.length || 0} members`);
    });

    // Compute league/season completion status
    const completionInfoMember = await checkLeagueCompletion(String(league.id));
    const computedStatusMember = {
      isCompleted: completionInfoMember.isCompleted,
      isComplete: completionInfoMember.isCompleted,
      locked: completionInfoMember.isCompleted,
      activeSeasonCompleted: completionInfoMember.activeSeasonCompleted,
      allStatsSubmitted: completionInfoMember.allStatsSubmitted,
      totalCompletedMatches: completionInfoMember.totalCompletedMatches,
      totalMaxGames: completionInfoMember.totalMaxGames,
      maxGames: league.maxGames,
      matchesPlayed: completionInfoMember.totalCompletedMatches,
      gamesPlayed: completionInfoMember.totalCompletedMatches,
      seasons: completionInfoMember.seasons.map(s => ({
        seasonId: s.seasonId,
        seasonNumber: s.seasonNumber,
        seasonName: s.seasonName,
        isActive: s.isActive,
        maxGames: s.maxGames,
        completedMatches: s.completedMatches,
        isCompleted: s.isCompleted,
        last2MatchesStatsComplete: s.last2MatchesStatsComplete,
        missingStatsPlayers: s.missingStatsPlayers,
      })),
      missing: completionInfoMember.missing,
    };
    const lifecycle = deriveLeagueLifecycle(
      Boolean(league.active),
      Boolean((league as any).archived),
      completionInfoMember.isCompleted,
      completionInfoMember.isCompleted
    );

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        inviteCode: (userCurrentSeason as any)?.inviteCode || league.inviteCode,
        active: league.active,
        archived: Boolean((league as any).archived),
        image: (league as any).image,
        maxGames: league.maxGames,
        createdAt: league.createdAt,
        updatedAt: league.updatedAt,
        status: lifecycle.status,
        isComplete: lifecycle.isComplete,
        isCompleted: lifecycle.isCompleted,
        isLocked: lifecycle.isLocked,
        members: membersJson,
        matches: matchesWithNumbers,
        seasons: filteredSeasons, // Only show seasons user is member of
        currentSeason: userCurrentSeason, // User's current season
        administrators: adminsJson,
        isAdmin,
        computedStatus: computedStatusMember
      }
    };
    cache.set(cacheKey, ctx.body, 8);
    ctx.set('X-Cache', 'MISS');
  } catch (err) {
    console.error('Get league by ID error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch league' };
  }
};

// Get league statistics
export const getLeagueStatistics = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    // Find the league
    const league = await League.findByPk(id, {
      include: [
        { model: User, as: 'members', attributes: ['id'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        {
          model: Season,
          as: 'seasons',
          where: { isActive: true, archived: false, deleted: false },
          required: false,
          include: [
            { model: User, as: 'players', attributes: ['id'] }
          ]
        }
      ]
    });

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    // Check access
    const isMember = (league as any).members?.some((m: any) => String(m.id) === String(userId));
    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(userId));

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    // Get active season
    const activeSeason = (league as any).seasons?.[0];
    const seasonId = activeSeason?.id;

    // Count completed matches
    let playedMatches = 0;
    let remaining = 0;

    if (seasonId) {
      const completedCount = await Match.count({
        where: {
          leagueId: id,
          seasonId: seasonId,
          status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
        }
      });
      playedMatches = completedCount;

      // Count remaining (scheduled matches)
      const scheduledCount = await Match.count({
        where: {
          leagueId: id,
          seasonId: seasonId,
          status: { [Op.notIn]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
        }
      });
      remaining = scheduledCount;
    }

    // Count players in active season
    const players = activeSeason?.players?.length || (league as any).members?.length || 0;

    // League created date
    const created = (league as any).createdAt?.toISOString() || new Date().toISOString();

    // For bestPairing and hottestPlayer - we'd need complex queries
    // For now, return null (can be enhanced later with MatchStatistics queries)
    let bestPairing: any = null;
    let hottestPlayer: any = null;

    // Try to find hottest player (most XP in recent matches)
    if (seasonId) {
      try {
        // Use raw query to avoid association issues
        const recentStats = await MatchStatistics.findAll({
          where: {},
          include: [
            {
              model: Match,
              as: 'match',
              where: {
                leagueId: id,
                seasonId: seasonId,
                status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
              },
              attributes: ['id', 'date'],
              required: true
            }
          ],
          attributes: [['user_id', 'userId'], ['xp_awarded', 'xpAwarded']],
          order: [[{ model: Match, as: 'match' }, 'date', 'DESC']],
          limit: 50
        });

        // Fetch user names separately
        const userIds = [...new Set(recentStats.map((s: any) => s.userId).filter(Boolean))];
        const users = userIds.length > 0 ? await User.findAll({
          where: { id: { [Op.in]: userIds } },
          attributes: ['id', 'firstName', 'lastName']
        }) : [];
        const userMap = Object.fromEntries(users.map((u: any) => [String(u.id), u]));

        // Group by player and sum XP
        const playerXP: Record<string, { playerId: string; name: string; xp: number; matches: number }> = {};
        for (const stat of recentStats) {
          const playerId = String((stat as any).userId);
          const user = userMap[playerId];
          if (!playerXP[playerId]) {
            playerXP[playerId] = {
              playerId,
              name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Unknown',
              xp: 0,
              matches: 0
            };
          }
          playerXP[playerId].xp += (stat as any).xpAwarded || 0;
          playerXP[playerId].matches += 1;
        }

        // Find hottest (most XP)
        const sorted = Object.values(playerXP).sort((a, b) => b.xp - a.xp);
        if (sorted.length > 0 && sorted[0].xp > 0) {
          hottestPlayer = {
            playerId: sorted[0].playerId,
            name: sorted[0].name,
            xpInLast5: sorted[0].xp,
            matchesConsidered: sorted[0].matches
          };
        }
      } catch (statsErr) {
        console.log('Could not fetch hottest player stats:', statsErr);
        // Non-critical, continue with null
      }
    }

    ctx.body = {
      success: true,
      data: {
        playedMatches,
        remaining,
        players,
        created,
        bestPairing,
        hottestPlayer
      }
    };
  } catch (err) {
    console.error('Get league statistics error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch league statistics' };
  }
};

// Get league XP for all members
export const getLeagueXP = async (ctx: Context) => {
  const { id } = ctx.params;
  const { seasonId: querySeasonId } = ctx.query as { seasonId?: string };

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `league_xp_${id}_${querySeasonId || 'active'}_${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    const [league, members, administeredLeagues, activeSeason] = await Promise.all([
      League.findByPk(id, { attributes: ['id'] }),
      User.findAll({
        attributes: ['id'],
        include: [
          {
            model: League,
            as: 'leagues',
            attributes: [],
            through: { attributes: [] },
            where: { id },
            required: true,
          }
        ]
      }),
      User.findAll({
        attributes: ['id'],
        include: [
          {
            model: League,
            as: 'administeredLeagues',
            attributes: [],
            through: { attributes: [] },
            where: { id },
            required: true,
          }
        ]
      }),
      Season.findOne({
        where: { leagueId: id, isActive: true, archived: false, deleted: false },
        attributes: ['id'],
        order: [['seasonNumber', 'DESC'], ['createdAt', 'DESC']]
      })
    ]);

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    const isMember = members.some((m: any) => String(m.id) === String(userId));
    const isAdmin = administeredLeagues.some((a: any) => String(a.id) === String(userId));

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    const seasonId = querySeasonId || (activeSeason ? String((activeSeason as any).id) : undefined);

    // Canonical source of truth: match_statistics.xp_awarded
    // (already computed at stats submission time).
    const xpMap: Record<string, number> = {};
    const avgMap: Record<string, number> = {};
    const matchCountMap: Record<string, number> = {};
    const sequelize = League.sequelize!;

    const memberIds = members.map((m: any) => String(m.id));
    memberIds.forEach((uid: string) => {
      xpMap[uid] = 0;
      avgMap[uid] = 0;
      matchCountMap[uid] = 0;
    });

    try {
      // Aggregate canonical XP from match_statistics.xp_awarded for real participants only.
      let xpQuery = `SELECT
           ms.user_id,
           COALESCE(SUM(ms.xp_awarded), 0) AS total_xp,
           COUNT(DISTINCT ms.match_id) AS match_count
         FROM match_statistics ms
         INNER JOIN "Matches" m ON m.id = ms.match_id
         WHERE m."leagueId" = $1
           AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')`;
      const binds: any[] = [id];
      if (seasonId) {
        xpQuery += ` AND m."seasonId" = $2`;
        binds.push(seasonId);
      }
      xpQuery += `
           AND (
             EXISTS (
               SELECT 1 FROM "UserHomeMatches" uh
               WHERE uh."matchId" = ms.match_id AND uh."userId" = ms.user_id
             )
             OR EXISTS (
               SELECT 1 FROM "UserAwayMatches" ua
               WHERE ua."matchId" = ms.match_id AND ua."userId" = ms.user_id
             )
           )
         GROUP BY ms.user_id`;

      const xpRows = await sequelize.query<{
        user_id: string;
        total_xp: number | string;
        match_count: number | string;
      }>(xpQuery, { bind: binds, type: QueryTypes.SELECT });

      xpRows.forEach((row) => {
        const uid = String(row.user_id);
        const totalXP = Number(row.total_xp) || 0;
        const matchCount = Number(row.match_count) || 0;
        xpMap[uid] = totalXP;
        matchCountMap[uid] = matchCount;
        avgMap[uid] = matchCount > 0 ? Math.round(totalXP / matchCount) : 0;
      });

      memberIds.forEach((uid) => {
        if (xpMap[uid] == null) xpMap[uid] = 0;
        if (avgMap[uid] == null) avgMap[uid] = 0;
        if (matchCountMap[uid] == null) matchCountMap[uid] = 0;
      });
    } catch (statsErr) {
      console.error('Could not compute league XP:', statsErr);
    }

    const payload = {
      success: true,
      xp: xpMap,
      avg: avgMap
    };
    cache.set(cacheKey, payload, 6);
    ctx.set('X-Cache', 'MISS');
    ctx.body = payload;
  } catch (err) {
    console.error('Get league XP error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch league XP' };
  }
};

// Get player quick view (MOTM count for a player in a league)
export const getPlayerQuickView = async (ctx: Context) => {
  const { id: leagueId, playerId } = ctx.params;
  const { seasonId: querySeasonId } = ctx.query as { seasonId?: string };

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  try {
    const requestedSeasonId = typeof querySeasonId === 'string' ? querySeasonId.trim() : '';
    const legacyUnseasonedMatches = await Match.count({
      where: {
        leagueId,
        seasonId: { [Op.is]: null },
        status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] },
        deleted: false
      } as any
    });
    const useWholeLeague = requestedSeasonId === 'all' || legacyUnseasonedMatches > 0;

    // Resolve seasonId: use query param if provided, otherwise find active season.
    // `seasonId=all` is used by legacy/migrated leagues whose matches are not season-linked.
    let seasonId = useWholeLeague ? '' : requestedSeasonId;
    if (!seasonId && !useWholeLeague) {
      const activeSeason = await Season.findOne({
        where: { leagueId, isActive: true, archived: false, deleted: false }
      });
      if (activeSeason) seasonId = String((activeSeason as any).id);
    }

    // Build match filter (league + optional season)
    const matchWhere: any = { leagueId };
    if (seasonId) matchWhere.seasonId = seasonId;

    // Count MOTM wins (number of matches where the player won MOTM) for this player in this league (filtered by season)
    const matches = await Match.findAll({
      where: {
        ...matchWhere,
        deleted: false
      },
      attributes: ['id'],
      include: [
        {
          model: Vote,
          as: 'votes',
          attributes: ['votedForId']
        }
      ]
    });

    let motmCount = 0;
    for (const match of matches) {
      const votes = (match as any).votes || [];
      if (votes.length === 0) continue;

      const voteCounts: Record<string, number> = {};
      for (const vote of votes) {
        const vId = String(vote.votedForId);
        voteCounts[vId] = (voteCounts[vId] || 0) + 1;
      }

      let maxVotes = 0;
      let winners = new Set<string>();
      for (const [vId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          winners.clear();
          winners.add(vId);
        } else if (count === maxVotes) {
          winners.add(vId);
        }
      }

      if (winners.has(String(playerId))) {
        motmCount++;
      }
    }

    // Fetch last 10 completed matches where this player participated (home or away)
    const completedStatuses = ['RESULT_PUBLISHED', 'RESULT_UPLOADED'];
    const matchFilter: any = {
      leagueId,
      status: { [Op.in]: completedStatuses },
    };
    if (seasonId) matchFilter.seasonId = seasonId;

    const [homeMatches, awayMatches] = await Promise.all([
      Match.findAll({
        where: matchFilter,
        include: [{
          model: User,
          as: 'homeTeamUsers',
          where: { id: playerId },
          attributes: ['id'],
          through: { attributes: [] } as any,
          required: true,
        }],
        attributes: ['id', 'homeTeamGoals', 'awayTeamGoals', 'end', 'resultPublishedAt', 'createdAt'],
        order: [['end', 'DESC']],
        limit: 10,
      } as any),
      Match.findAll({
        where: matchFilter,
        include: [{
          model: User,
          as: 'awayTeamUsers',
          where: { id: playerId },
          attributes: ['id'],
          through: { attributes: [] } as any,
          required: true,
        }],
        attributes: ['id', 'homeTeamGoals', 'awayTeamGoals', 'end', 'resultPublishedAt', 'createdAt'],
        order: [['end', 'DESC']],
        limit: 10,
      } as any),
    ]);

    // Combine, deduplicate, sort by date desc, take last 10
    const matchMap = new Map<string, { id: string; homeGoals: number; awayGoals: number; team: 'home' | 'away'; date: string }>();

    for (const m of homeMatches) {
      const mAny = m as any;
      matchMap.set(String(mAny.id), {
        id: String(mAny.id),
        homeGoals: Number(mAny.homeTeamGoals ?? 0),
        awayGoals: Number(mAny.awayTeamGoals ?? 0),
        team: 'home',
        date: mAny.end || mAny.resultPublishedAt || mAny.createdAt || '',
      });
    }
    for (const m of awayMatches) {
      const mAny = m as any;
      const id = String(mAny.id);
      if (!matchMap.has(id)) {
        matchMap.set(id, {
          id,
          homeGoals: Number(mAny.homeTeamGoals ?? 0),
          awayGoals: Number(mAny.awayTeamGoals ?? 0),
          team: 'away',
          date: mAny.end || mAny.resultPublishedAt || mAny.createdAt || '',
        });
      }
    }

    const allMatches = Array.from(matchMap.values())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 10);

    const lastFive = allMatches.map((m) => {
      const myGoals = m.team === 'home' ? m.homeGoals : m.awayGoals;
      const oppGoals = m.team === 'home' ? m.awayGoals : m.homeGoals;
      let result: 'W' | 'D' | 'L' = 'D';
      if (myGoals > oppGoals) result = 'W';
      else if (myGoals < oppGoals) result = 'L';
      return { result };
    });

    const player = await User.findByPk(playerId, {
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'preferredFoot', 'shirtNumber', 'skills', 'xp']
    });

    ctx.body = {
      success: true,
      motmCount: motmCount || 0,
      lastFive,
      player: player ? {
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        profilePicture: player.profilePicture,
        position: player.position,
        preferredFoot: player.preferredFoot,
        shirtNumber: player.shirtNumber,
        xp: player.xp || 0,
      } : null,
      skills: player?.skills || null,
      xp: player?.xp || 0,
      profileXP: player?.xp || 0,
    };
  } catch (err) {
    console.error('Get player quick view error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch player quick view' };
  }
};

// Create league
export const createLeague = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;
  const { name, maxGames } = ctx.request.body as any;

  if (!name) {
    ctx.throw(400, 'League name is required');
    return;
  }

  try {
    let imageUrl = null;
    if ((ctx.request as any).file) {
      const file = (ctx.request as any).file;
      imageUrl = await uploadToCloudinary(file.buffer, 'league-images');
    }

    // Default maxGames to 20 if not provided
    const leagueMaxGames = maxGames ? Number(maxGames) : 20;

    // Legacy league invite code (season codes are now primary for joining)
    const inviteCode = getInviteCode();
    const seasonInviteCode = await generateUniqueSeasonInviteCode();

    const league = await League.create({
      name,
      maxGames: leagueMaxGames,
      active: true,
      image: imageUrl,
      inviteCode
    } as any);

    const creator = await User.findByPk(userId);
    if (creator) {
      await (league as any).addMember(creator);
      await (league as any).addAdministeredLeague(creator);
    }

    // Create Season 1 automatically
    const season1 = await Season.create({
      leagueId: league.id,
      seasonNumber: 1,
      name: 'Season 1',
      inviteCode: seasonInviteCode,
      isActive: true,
      startDate: new Date(),
      showPoints: true,
    } as any);

    // Add creator to Season 1
    if (creator) {
      await (season1 as any).addPlayer(creator);
    }

    cache.clearPattern(`user_leagues_${userId}`);
    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${league.id}`);
    cache.clearPattern(`matches_league_${league.id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.status = 201;
    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        inviteCode: seasonInviteCode,
        seasonInviteCode,
        maxGames: league.maxGames,
        image: imageUrl,
        seasonId: season1.id,
        seasonNumber: season1.seasonNumber,
      }
    };
  } catch (err: any) {
    console.error('Create league error', err);
    
    // Handle unique constraint violation for league name
    if (err?.name === 'SequelizeUniqueConstraintError' && err?.fields?.name) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'A league with this name already exists. Please choose a different name.' };
      return;
    }
    
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to create league' };
  }
};

// Update league status
export const updateLeagueStatus = async (ctx: Context) => {
  const { id } = ctx.params;
  const { active, status, archived } = ctx.request.body as any;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const league = await League.findByPk(id, {
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const userId = ctx.state.user.userId || ctx.state.user.id;
    const adminList = (league as any).administeredLeagues || [];
    let isAdmin = adminList.some((a: any) => String(a.id) === String(userId));

    // Fallback: association may be stale/missing in some environments
    if (!isAdmin) {
      const directResult = await (League as any).sequelize.query(
        'SELECT "userId" FROM "LeagueAdmin" WHERE "leagueId" = :leagueId AND "userId" = :userId LIMIT 1',
        { replacements: { leagueId: id, userId }, type: (League as any).sequelize.QueryTypes.SELECT }
      );
      isAdmin = Array.isArray(directResult) && directResult.length > 0;
    }
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update status');
      return;
    }

    const normalizeBoolean = (value: unknown): boolean | undefined => {
      if (value === true || value === false) return value;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
      }
      return undefined;
    };

    const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';
    const completedStatusTokens = new Set([
      'completed',
      'complete',
      'finished',
      'ended',
      'result_published',
      'result_uploaded',
      'result_complete',
      'result_finished',
      'result_ended',
      'result_done',
    ]);

    const requestedActive = normalizeBoolean(active);
    const requestedArchived = normalizeBoolean(archived);

    const updateData: any = {};

    if (completedStatusTokens.has(normalizedStatus)) {
      // Completed league must NOT be archived.
      // Persist as inactive+non-archived so frontend can keep it in "Completed", not "Archived".
      updateData.active = false;
      updateData.archived = false;
      if ('isLocked' in (league as any)) updateData.isLocked = true;
      if ('completedAt' in (league as any)) updateData.completedAt = new Date();
      if ('completedById' in (league as any)) updateData.completedById = String(userId);
      console.log(`🏁 League "${league.name}" marked completed by admin`);
    } else if (normalizedStatus === 'active' || normalizedStatus === 'live') {
      updateData.active = true;
      updateData.archived = false;
      if ('isLocked' in (league as any)) updateData.isLocked = false;
      if ('completedAt' in (league as any)) updateData.completedAt = null;
      if ('completedById' in (league as any)) updateData.completedById = null;
      console.log(`🟢 League "${league.name}" marked live by admin`);
    } else if (requestedActive !== undefined) {
      // Legacy behavior for settings/admin archive switches
      updateData.active = requestedActive;
      if (requestedActive) {
        updateData.archived = requestedArchived ?? false;
      } else {
        updateData.archived = requestedArchived ?? true;
      }
      if (updateData.archived === true) {
        console.log(`📦 League "${league.name}" archived by admin (marked inactive)`);
      }
    } else if (requestedArchived !== undefined) {
      updateData.archived = requestedArchived;
      if (requestedArchived) updateData.active = false;
    }

    if (Object.keys(updateData).length === 0) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'No valid status fields supplied' };
      return;
    }

    await league.update(updateData);

    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${id}`);
    cache.clearPattern(`matches_league_${id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        active: league.active,
        archived: (league as any).archived,
        status: (league as any).archived ? 'inactive' : (league.active ? 'active' : 'completed'),
        isComplete: !(league as any).archived && league.active === false,
        isCompleted: !(league as any).archived && league.active === false,
        locked: Boolean((league as any).isLocked) || (!(league as any).archived && league.active === false),
      }
    };
  } catch (err) {
    console.error('Update league status error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update league' };
  }
};

// Explicit API for switch button: mark a league completed
export const markLeagueCompleted = async (ctx: Context) => {
  const body = (ctx.request.body || {}) as Record<string, unknown>;
  ctx.request.body = {
    ...body,
    status: 'completed',
    active: false,
    archived: false,
  };
  await updateLeagueStatus(ctx);
};

// Explicit API for switch button: mark a league live again
export const markLeagueLive = async (ctx: Context) => {
  const body = (ctx.request.body || {}) as Record<string, unknown>;
  ctx.request.body = {
    ...body,
    status: 'active',
    active: true,
    archived: false,
  };
  await updateLeagueStatus(ctx);
};

// Update league
export const updateLeague = async (ctx: Context) => {
  const { id } = ctx.params;
  const {
    name,
    maxGames,
    active,
    status,
    archived,
    showPoints,
    removeImage,
    seasonId,
    seasonMaxGames,
    seasonShowPoints,
    seasonArchived,
    seasonStatus,
    seasonIsActive,
    seasonActive,
  } = ctx.request.body as any;
  let { admins } = ctx.request.body as any;

  // When sent via FormData, admins arrives as a JSON string — parse it
  if (typeof admins === 'string') {
    try { admins = JSON.parse(admins); } catch { admins = undefined; }
  }

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const league = await League.findByPk(id, {
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const userId = ctx.state.user.userId || ctx.state.user.id;
    
    // Check admin via association first, then fallback to direct DB query
    const adminList = (league as any).administeredLeagues || [];
    console.log('🔍 updateLeague admin check:', {
      userId,
      leagueId: id,
      adminIds: adminList.map((a: any) => a.id),
      adminCount: adminList.length
    });
    let isAdmin = adminList.some((a: any) => String(a.id) === String(userId));
    
    if (!isAdmin) {
      // Fallback: direct query on LeagueAdmin table
      const directResult = await (League as any).sequelize.query(
        'SELECT "userId" FROM "LeagueAdmin" WHERE "leagueId" = :leagueId AND "userId" = :userId LIMIT 1',
        { replacements: { leagueId: id, userId }, type: (League as any).sequelize.QueryTypes.SELECT }
      );
      console.log('🔍 updateLeague fallback query result:', JSON.stringify(directResult));
      isAdmin = Array.isArray(directResult) && directResult.length > 0;
    }
    
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update');
      return;
    }

    const normalizeBoolean = (value: unknown): boolean | undefined => {
      if (value === true || value === false) return value;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
      }
      return undefined;
    };

    const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';
    const completedStatusTokens = new Set([
      'completed',
      'complete',
      'finished',
      'ended',
      'result_published',
      'result_uploaded',
      'result_complete',
      'result_finished',
      'result_ended',
      'result_done',
    ]);

    const requestedActive = normalizeBoolean(active);
    const requestedArchived = normalizeBoolean(archived);

    const updateData: any = {};
    if (name) updateData.name = name;
    if (maxGames !== undefined) updateData.maxGames = Number(maxGames);
    // Manual completed/live status support:
    // completed => inactive but NOT archived
    if (completedStatusTokens.has(normalizedStatus)) {
      updateData.active = false;
      updateData.archived = false;
      if ('isLocked' in (league as any)) updateData.isLocked = true;
      if ('completedAt' in (league as any)) updateData.completedAt = new Date();
      if ('completedById' in (league as any)) updateData.completedById = String(userId);
    } else if (normalizedStatus === 'active' || normalizedStatus === 'live') {
      updateData.active = true;
      updateData.archived = false;
      if ('isLocked' in (league as any)) updateData.isLocked = false;
      if ('completedAt' in (league as any)) updateData.completedAt = null;
      if ('completedById' in (league as any)) updateData.completedById = null;
    } else {
      // Handle boolean fields that may arrive as strings from FormData
      if (requestedActive !== undefined) updateData.active = requestedActive;
      if (requestedArchived !== undefined) updateData.archived = requestedArchived;
    }
    if (showPoints !== undefined) updateData.showPoints = showPoints === true || showPoints === 'true';

    // Handle league image upload or removal
    if ((ctx.request as any).file) {
      const file = (ctx.request as any).file;
      const imageUrl = await uploadToCloudinary(file.buffer, 'league-images');
      updateData.image = imageUrl;
    } else if (removeImage === 'true' || removeImage === true) {
      updateData.image = null;
    }

    await league.update(updateData);

    // Update admin(s) if provided
    if (Array.isArray(admins) && admins.length > 0) {
      // Verify all new admins are valid user IDs that exist
      const validAdmins = await User.findAll({
        where: { id: { [Op.in]: admins } },
        attributes: ['id']
      });
      const validAdminIds = validAdmins.map((u: any) => u.id);

      let scopedAdminIds = validAdminIds;
      if (seasonId) {
        const seasonForAdmins = await Season.findByPk(seasonId, {
          include: [
            {
              model: User,
              as: 'players',
              attributes: ['id'],
              through: { attributes: [] },
              required: false,
            }
          ]
        });

        if (!seasonForAdmins || String(seasonForAdmins.leagueId) !== String(id) || Boolean((seasonForAdmins as any).deleted)) {
          ctx.status = 400;
          ctx.body = { success: false, message: 'Selected season is invalid for this league' };
          return;
        }

        const seasonPlayerIds = new Set(
          (((seasonForAdmins as any).players || []) as Array<{ id?: string | number }>)
            .map((player) => String(player.id || '').trim())
            .filter((playerId) => playerId.length > 0)
        );

        const invalidAdminIds = validAdminIds.filter((adminCandidateId: string) => !seasonPlayerIds.has(String(adminCandidateId)));
        if (invalidAdminIds.length > 0) {
          ctx.status = 400;
          ctx.body = {
            success: false,
            message: 'Selected league admin must be an active player in the selected season',
          };
          return;
        }

        scopedAdminIds = validAdminIds;
      }

      if (scopedAdminIds.length > 0) {
        // Replace all current admins with the new admin(s)
        await (league as any).setAdministeredLeagues(scopedAdminIds);
        console.log(`✅ League ${id} admin(s) updated to:`, scopedAdminIds);
      }
    }

    // Update season settings if provided (handled here to avoid separate request + admin re-check)
    if (seasonId) {
      const season = await Season.findByPk(seasonId);
      if (season && String(season.leagueId) === String(id) && !(season as any).deleted) {
        if (seasonMaxGames !== undefined) season.maxGames = Number(seasonMaxGames);
        if (seasonShowPoints !== undefined) season.showPoints = seasonShowPoints === true || seasonShowPoints === 'true';
        const seasonArchivedBool = seasonArchived === true || seasonArchived === 'true';
        const seasonActiveBool = seasonIsActive === true || seasonIsActive === 'true' || seasonActive === true || seasonActive === 'true';
        const normalizedSeasonStatus = typeof seasonStatus === 'string' ? seasonStatus.trim().toLowerCase() : '';

        if (seasonArchived !== undefined || normalizedSeasonStatus === 'archived') {
          (season as any).archived = normalizedSeasonStatus === 'archived' ? true : seasonArchivedBool;
          if ((season as any).archived) {
            season.isActive = false;
            if (!season.endDate) season.endDate = new Date();
          }
        }

        if (seasonIsActive !== undefined || seasonActive !== undefined || normalizedSeasonStatus === 'active' || normalizedSeasonStatus === 'inactive') {
          if (normalizedSeasonStatus === 'active') {
            season.isActive = true;
            (season as any).archived = false;
          } else if (normalizedSeasonStatus === 'inactive') {
            season.isActive = false;
          } else {
            season.isActive = seasonActiveBool;
            if (seasonActiveBool) (season as any).archived = false;
          }
        }

        if (season.isActive) {
          await Season.update(
            { isActive: false },
            {
              where: {
                leagueId: season.leagueId,
                id: { [Op.ne]: season.id },
                deleted: false,
              },
            }
          );
        }

        await season.save();
        console.log(`✅ Season ${seasonId} settings updated: maxGames=${season.maxGames}, showPoints=${season.showPoints}, archived=${(season as any).archived}, isActive=${season.isActive}`);
      }
    }

    // Fetch updated admin list
    const updatedLeague = await League.findByPk(id, {
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id', 'firstName', 'lastName'] }]
    });

    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${id}`);
    cache.clearPattern(`matches_league_${id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: (updatedLeague as any)?.name || league.name,
        maxGames: (updatedLeague as any)?.maxGames || league.maxGames,
        active: (updatedLeague as any)?.active ?? league.active,
        archived: Boolean((updatedLeague as any)?.archived ?? (league as any).archived),
        status: Boolean((updatedLeague as any)?.archived ?? (league as any).archived)
          ? 'inactive'
          : (((updatedLeague as any)?.active ?? league.active) ? 'active' : 'completed'),
        isComplete: !Boolean((updatedLeague as any)?.archived ?? (league as any).archived)
          && ((updatedLeague as any)?.active ?? league.active) === false,
        isCompleted: !Boolean((updatedLeague as any)?.archived ?? (league as any).archived)
          && ((updatedLeague as any)?.active ?? league.active) === false,
        showPoints: (updatedLeague as any)?.showPoints ?? league.showPoints,
        image: (updatedLeague as any)?.image ?? (league as any).image ?? null,
        administrators: (updatedLeague as any)?.administeredLeagues || []
      }
    };
  } catch (err) {
    console.error('Update league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update league' };
  }
};

// Delete league (hard delete by default; soft archive via ?mode=soft)
export const deleteLeague = async (ctx: Context) => {
  const { id } = ctx.params;
  const queryMode = typeof ctx.query?.mode === 'string' ? ctx.query.mode.trim().toLowerCase() : '';
  const bodyModeRaw = (ctx.request as any)?.body?.mode;
  const bodyMode = typeof bodyModeRaw === 'string' ? bodyModeRaw.trim().toLowerCase() : '';
  const softDelete = queryMode === 'soft' || bodyMode === 'soft';

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const league = await League.findByPk(id, {
      include: [
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName'] }
      ]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can delete');
      return;
    }

    const members: any[] = (league as any).members || [];
    const totalMatchesCreated = await Match.count({ where: { leagueId: id } });
    const hasAnyMatchesCreated = totalMatchesCreated > 0;

    if (hasAnyMatchesCreated && !softDelete) {
      ctx.status = 409;
      ctx.body = {
        success: false,
        message: 'This league already has matches and cannot be permanently deleted. Please archive it from League Settings.',
      };
      return;
    }

    if (softDelete) {
      await league.update({ active: false, archived: true });
      if (members.length > 0) {
        await (league as any).setMembers([]);
        await (league as any).setAdministeredLeagues([]);
      }

      try {
        const notifications = members.map((m: any) => ({
          user_id: String(m.id),
          type: 'LEAGUE_DELETED',
          title: 'League Deleted',
          body: `The league "${league.name}" has been deleted by the admin. Your XP points have been preserved.`,
          meta: {
            leagueId: id,
            leagueName: league.name,
            mode: 'soft'
          },
          read: false,
          created_at: new Date(),
        }));
        if (notifications.length > 0) {
          await Notification.bulkCreate(notifications);
        }
      } catch (notifErr) {
        console.error('Failed to send league deletion notifications:', notifErr);
      }

      cache.clearPattern(`user_leagues_`);
      cache.clearPattern(`auth_status_`);
      cache.clearPattern(`league_${id}`);
      cache.clearPattern(`matches_league_${id}`);
      try {
        invalidateServerCache('/leagues');
        invalidateServerCache('/matches');
      } catch {}

      ctx.body = {
        success: true,
        message: 'League archived successfully (soft delete).'
      };
      return;
    }

    const sequelize = League.sequelize!;
    const tx = await sequelize.transaction();
    const replacements = { leagueId: id };

    const runDelete = async (sql: string) => {
      try {
        await sequelize.query(sql, {
          replacements,
          type: QueryTypes.DELETE,
          transaction: tx,
        });
      } catch (qErr: any) {
        const code = qErr?.original?.code || qErr?.parent?.code || qErr?.code;
        if (code === '42P01') {
          console.warn('[deleteLeague] Optional table missing, skipping cleanup query');
          return;
        }
        throw qErr;
      }
    };

    try {
      await runDelete(`DELETE FROM "Votes" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "match_statistics" WHERE "match_id" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "MatchGuests" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "match_availabilities" WHERE "match_id" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "match_player_layouts" WHERE "matchId" IN (SELECT id::text FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "UserHomeMatches" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "UserAwayMatches" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "UserMatchAvailability" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "UserMatchStatistics" WHERE "matchId" IN (SELECT id FROM "Matches" WHERE "leagueId" = :leagueId)`);
      await runDelete(`DELETE FROM "SeasonPlayers" WHERE "seasonId" IN (SELECT id FROM "Seasons" WHERE "leagueId" = :leagueId)`);

      await Match.destroy({ where: { leagueId: id }, transaction: tx });
      await Season.destroy({ where: { leagueId: id }, transaction: tx });

      await runDelete(`DELETE FROM "LeagueMember" WHERE "leagueId" = :leagueId`);
      await runDelete(`DELETE FROM "LeagueAdmin" WHERE "leagueId" = :leagueId`);

      await league.destroy({ transaction: tx });
      await tx.commit();
    } catch (hardErr) {
      await tx.rollback();
      throw hardErr;
    }

    try {
      const notifications = members.map((m: any) => ({
        user_id: String(m.id),
        type: 'LEAGUE_DELETED',
        title: 'League Deleted',
        body: `The league "${league.name}" has been permanently deleted by the admin.`,
        meta: {
          leagueId: id,
          leagueName: league.name,
          mode: 'hard'
        },
        read: false,
        created_at: new Date(),
      }));
      if (notifications.length > 0) {
        await Notification.bulkCreate(notifications);
      }
    } catch (notifErr) {
      console.error('Failed to send hard-delete notifications:', notifErr);
    }

    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${id}`);
    cache.clearPattern(`matches_league_${id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      message: 'League permanently deleted from database.'
    };
  } catch (err) {
    console.error('Delete league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to delete league' };
  }
};

// Join league
export const joinLeague = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;
  const { inviteCode } = ctx.request.body as any;
  const normalizedInviteCode = String(inviteCode || '').trim().toUpperCase();

  if (!normalizedInviteCode) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'Please enter an invite code' };
    return;
  }

  try {
    // Primary: season invite codes
    let targetSeason = await Season.findOne({
      where: { inviteCode: normalizedInviteCode, deleted: false } as any,
      include: [
        {
          model: League,
          as: 'league',
          attributes: ['id', 'name', 'active', 'archived'],
        },
        {
          model: User,
          as: 'players',
          attributes: ['id'],
          through: { attributes: [] },
          required: false,
        }
      ]
    });

    let league = ((targetSeason as any)?.league || null) as any;

    // Backward compatibility: legacy league-level invite codes
    if (!targetSeason) {
      league = await League.findOne({
        where: { inviteCode: normalizedInviteCode },
        include: [
          { model: User, as: 'members', attributes: ['id'] },
          {
            model: Season,
            as: 'seasons',
            where: { isActive: true, archived: false, deleted: false },
            required: false,
            include: [
              {
                model: User,
                as: 'players',
                attributes: ['id'],
                through: { attributes: [] },
                required: false,
              }
            ]
          }
        ]
      });

      if (league) {
        targetSeason = ((league as any).seasons?.[0] || null) as any;
      }
    }

    if (!league || !targetSeason) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'No season found with this invite code. Please check and try again.' };
      return;
    }

    // Ensure league includes members for membership checks.
    if (!(league as any).members) {
      league = await League.findByPk(String(league.id), {
        include: [{ model: User, as: 'members', attributes: ['id'] }]
      });
    }
    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    if ((league as any).active === false || Boolean((league as any).archived)) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'This league is currently inactive. Please contact the admin.' };
      return;
    }

    if (targetSeason.isActive === false || Boolean((targetSeason as any).archived) || Boolean((targetSeason as any).deleted)) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'This season is not active for new joins.' };
      return;
    }

    let seasonPlayers = ((targetSeason as any).players || []) as Array<{ id?: string | number }>;
    if (seasonPlayers.length === 0) {
      try {
        seasonPlayers = await (targetSeason as any).getPlayers({
          attributes: ['id'],
          joinTableAttributes: [],
        });
      } catch {
        seasonPlayers = [];
      }
    }

    const isMember = ((league as any).members || []).some((m: any) => String(m.id) === String(userId));
    const isSeasonMember = seasonPlayers.some((p: any) => String(p.id) === String(userId));
    if (isSeasonMember) {
      ctx.status = 409;
      ctx.body = { success: false, message: 'You are already joined to this season' };
      return;
    }

    const user = await User.findByPk(userId);
    if (user) {
      if (!isMember) {
        await (league as any).addMember(user);
      }
      try {
        await (targetSeason as any).addPlayer(user);
      } catch (addError) {
        const err = addError as { message?: string; original?: { code?: string }; parent?: { code?: string } };
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.original?.code || err?.parent?.code || '').toLowerCase();
        const isDuplicateMembership = code === '23505' || msg.includes('duplicate') || msg.includes('unique');
        if (!isDuplicateMembership) {
          throw addError;
        }
      }
    }

    // Mark related NEW_SEASON notification as joined (if present).
    try {
      const seasonNotifications = await Notification.findAll({
        where: { user_id: userId, type: 'NEW_SEASON' },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'meta'],
      });

      const targetLeagueId = String((league as any).id || '').trim();
      const targetSeasonId = String((targetSeason as any).id || '').trim();

      await Promise.all(
        seasonNotifications.map(async (notification) => {
          const metaRaw = (notification as any)?.meta;
          if (!metaRaw || typeof metaRaw !== 'object') return;
          const metaRecord = metaRaw as Record<string, unknown>;
          const metaLeagueId = String(metaRecord.leagueId || '').trim();
          const metaSeasonId = String(metaRecord.seasonId || '').trim();
          if (metaLeagueId !== targetLeagueId || metaSeasonId !== targetSeasonId) return;
          await notification.update({
            meta: {
              ...metaRecord,
              actionTaken: 'joined',
              actionSource: 'invite-code',
              joinedAt: new Date().toISOString(),
            },
            read: true,
          } as any);
        })
      );
    } catch (notificationUpdateError) {
      console.warn('[joinLeague] failed to update NEW_SEASON notification state:', notificationUpdateError);
    }

    cache.clearPattern(`user_leagues_${userId}`);
    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${(league as any).id}`);
    cache.clearPattern(`matches_league_${(league as any).id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      message: 'Successfully joined season',
      league: {
        id: (league as any).id,
        name: (league as any).name,
      },
      season: {
        id: (targetSeason as any).id,
        seasonNumber: (targetSeason as any).seasonNumber,
        name: (targetSeason as any).name,
        inviteCode: (targetSeason as any).inviteCode || '',
      },
    };
  } catch (err) {
    console.error('Join league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to join league' };
  }
};

// Leave league
export const leaveLeague = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    const league = await League.findByPk(id, {
      include: [
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName'] },
        { model: User, as: 'administeredLeagues', attributes: ['id', 'firstName', 'lastName'] }
      ]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const members: any[] = (league as any).members || [];
    const admins: any[] = (league as any).administeredLeagues || [];
    const isAdmin = admins.some((a: any) => String(a.id) === String(userId));

    // If user is an admin, auto-reassign admin to another member before leaving
    if (isAdmin) {
      const otherMembers = members.filter((m: any) => String(m.id) !== String(userId));

      if (otherMembers.length === 0) {
        // No other members — archive the league instead
        await league.update({ active: false, archived: true });
        // Remove the last member (admin)
        const user = await User.findByPk(userId);
        if (user) {
          await (league as any).removeMember(user);
          await (league as any).removeAdministeredLeagues(user);
        }
        cache.clearPattern(`user_leagues_`);
        cache.clearPattern(`auth_status_`);
        cache.clearPattern(`league_${id}`);
        cache.clearPattern(`matches_league_${id}`);
        try {
          invalidateServerCache('/leagues');
          invalidateServerCache('/matches');
        } catch {}
        ctx.body = {
          success: true,
          message: 'You were the last member. League has been archived.',
          archived: true
        };
        return;
      }

      // Pick new admin: prefer the one specified by frontend, otherwise first other member
      const body = (ctx.request as any).body || {};
      const preferredAdminId = body.preferredAdminId ? String(body.preferredAdminId) : null;
      const preferredAdmin = preferredAdminId
        ? otherMembers.find((m: any) => String(m.id) === preferredAdminId)
        : null;
      const newAdmin = preferredAdmin || otherMembers[0];
      await (league as any).setAdministeredLeagues([newAdmin.id]);
      console.log(`🔄 Admin reassigned in league "${league.name}": ${newAdmin.firstName} ${newAdmin.lastName} (${newAdmin.id})`);

      // Send notification to ALL members about new admin
      try {
        const newAdminName = `${newAdmin.firstName || ''} ${newAdmin.lastName || ''}`.trim() || 'a new player';
        const notifications = otherMembers.map((m: any) => ({
          user_id: String(m.id),
          type: 'ADMIN_REASSIGNED',
          title: '👑 New Admin Selected',
          body: `New admin selected, ${newAdminName}.`,
          meta: {
            leagueId: id,
            leagueName: league.name,
            newAdminId: String(newAdmin.id),
            newAdminName,
            previousAdminId: userId,
          },
          read: false,
          created_at: new Date(),
        }));
        await Notification.bulkCreate(notifications);
      } catch (notifErr) {
        console.error('Failed to send admin reassignment notification:', notifErr);
      }
    }

    // Remove the user from the league
    const user = await User.findByPk(userId);
    if (user) {
      await (league as any).removeMember(user);
      if (isAdmin) {
        await (league as any).removeAdministeredLeagues(user);
      }
    }

    // Ensure the leaving user is removed from all match/team assignments in this league
    try {
      await removeUserFromLeagueMatchAssignments(String(id), String(userId));
    } catch (cleanupErr) {
      console.error('Failed to remove user from league match assignments:', cleanupErr);
    }

    // Check if the league is now empty — archive it
    const remainingMembers = await (League.findByPk(id, {
      include: [{ model: User, as: 'members', attributes: ['id'] }]
    }));
    const remainingCount = ((remainingMembers as any)?.members || []).length;
    if (remainingCount === 0) {
      await League.update({ active: false, archived: true }, { where: { id } });
      console.log(`📦 League "${league.name}" archived — no members remaining`);
    }

    cache.clearPattern(`user_leagues_${userId}`);
    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`auth_status_`);
    cache.clearPattern(`league_${id}`);
    cache.clearPattern(`matches_league_${id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      message: 'Successfully left league'
    };
  } catch (err) {
    console.error('Leave league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to leave league' };
  }
};

// Remove user from league
export const removeUserFromLeague = async (ctx: Context) => {
  const { id, userId: targetUserId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const league = await League.findByPk(id, {
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only admins can remove users');
      return;
    }

    const user = await User.findByPk(targetUserId);
    if (user) {
      await (league as any).removeMember(user);
    }

    // Keep match/team selections in sync when admin removes a member
    try {
      await removeUserFromLeagueMatchAssignments(String(id), String(targetUserId));
    } catch (cleanupErr) {
      console.error('Failed to remove kicked user from league match assignments:', cleanupErr);
    }

    // Check if league is now empty — if so, archive it
    const updatedLeague = await League.findByPk(id, {
      include: [{ model: User, as: 'members', attributes: ['id'] }]
    });
    const remainingCount = ((updatedLeague as any)?.members || []).length;
    if (remainingCount === 0) {
      await League.update({ active: false, archived: true }, { where: { id } });
      console.log(`📦 League "${league.name}" archived — no members remaining after removal`);
    }

    cache.clearPattern(`user_leagues_`);
    cache.clearPattern(`league_${id}`);
    cache.clearPattern(`matches_league_${id}`);
    try {
      invalidateServerCache('/leagues');
      invalidateServerCache('/matches');
    } catch {}

    ctx.body = {
      success: true,
      message: 'User removed from league'
    };
  } catch (err) {
    console.error('Remove user from league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to remove user' };
  }
};

// Notify all league members about new season
export const notifyMembersNewSeason = async (ctx: Context) => {
  try {
    const { id: leagueId } = ctx.params;
    const { seasonNumber, leagueName } = ctx.request.body as { seasonNumber?: number; leagueName?: string };

    // Verify user is league admin
    const league = await League.findByPk(leagueId, {
      include: [
        {
          model: User,
          as: 'administeredLeagues',
          where: { id: ctx.state.user.userId }
        },
        {
          model: User,
          as: 'members',
          attributes: ['id', 'email', 'firstName', 'lastName']
        }
      ]
    });

    if (!league) {
      ctx.throw(403, 'You are not an administrator of this league');
      return;
    }

    const members = (league as any).members || [];
    const currentUserId = ctx.state.user.userId;

    // Send notification to all members except the admin who created it
    const Notification = (await importWithFallback('../models/Notification.js')).default as any;
    
    const notificationsToCreate = members
      .filter((member: any) => member.id !== currentUserId)
      .map((member: any) => ({
        user_id: member.id,
        type: 'NEW_SEASON',
        title: `New Season in ${leagueName || league.name}!`,
        body: `The previous season has ended. Season ${seasonNumber || 'new'} has been created. Would you like to join?`,
        meta: {
          leagueId: league.id,
          leagueName: leagueName || league.name,
          seasonNumber: seasonNumber,
          actions: [
            {
              type: 'JOIN_SEASON',
              label: 'Join Season',
              action: 'join'
            },
            {
              type: 'DECLINE_SEASON',
              label: 'No, Thanks',
              action: 'decline'
            }
          ]
        },
        read: false,
        created_at: new Date()
      }));

    if (notificationsToCreate.length > 0) {
      await Notification.bulkCreate(notificationsToCreate);
      console.log(`✅ Sent new season notifications to ${notificationsToCreate.length} members`);
    }

    ctx.body = {
      success: true,
      message: `Notifications sent to ${notificationsToCreate.length} members`,
      notifiedCount: notificationsToCreate.length
    };
  } catch (err) {
    console.error('Notify members new season error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to send notifications' };
  }
};

// Create match in league - automatically uses active season
export const createMatchInLeague = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const { id: leagueId } = ctx.params;
  
  // Get form data (FormData from frontend)
  const body = ctx.request.body as any;
  const files = (ctx.request as any).files as any;

  const {
    homeTeamName,
    awayTeamName,
    date,
    start,
    end,
    location,
    notes,
    homeTeamUsers,
    awayTeamUsers,
    homeCaptain,
    awayCaptain
  } = body;

  let parsedHomeIds: string[] = [];
  let parsedAwayIds: string[] = [];
  try {
    parsedHomeIds = parseJsonArrayField(homeTeamUsers, 'homeTeamUsers').map((id: unknown) => String(id));
    parsedAwayIds = parseJsonArrayField(awayTeamUsers, 'awayTeamUsers').map((id: unknown) => String(id));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid team payload';
    ctx.status = 400;
    ctx.body = { success: false, message };
    return;
  }

  if (!date || !start || !end) {
    ctx.throw(400, 'date, start and end times are required');
    return;
  }

  try {
    // Verify league exists
    const league = await League.findByPk(leagueId);
    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    if (league.active === false) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: 'This league is currently inactive. To create new matches, please reactivate the league in League Settings.',
      };
      return;
    }

    // Find the ACTIVE season for this league
    const activeSeason = await Season.findOne({
      where: {
        leagueId,
        isActive: true,
        archived: false,
        deleted: false,
      }
    });

    if (!activeSeason) {
      ctx.throw(400, 'No active season found for this league. Please create a season first.');
      return;
    }

    const teamUploadRequested = parsedHomeIds.length > 0 || parsedAwayIds.length > 0;
    if (teamUploadRequested) {
      const uniqueRegisteredPlayers = new Set<string>([...parsedHomeIds, ...parsedAwayIds]).size;
      const validationMessage = validateTeamUploadThresholds(uniqueRegisteredPlayers, uniqueRegisteredPlayers);
      if (validationMessage) {
        ctx.status = 400;
        ctx.body = { success: false, message: validationMessage };
        return;
      }
    }

    console.log(`📅 Creating match for league ${leagueId} in active Season ${activeSeason.seasonNumber} (${activeSeason.id})`);

    // 🚫 Check if season has reached maxGames limit
    if (activeSeason.maxGames && activeSeason.maxGames > 0) {
      const currentMatchCount = await Match.count({
        where: {
          leagueId,
          seasonId: activeSeason.id
        }
      });

      if (currentMatchCount >= activeSeason.maxGames) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: `Maximum match limit reached for Season ${activeSeason.seasonNumber}. Limit: ${activeSeason.maxGames} matches. Please start a new season to create more matches.`
        };
        return;
      }

      console.log(`✅ Season match limit check: ${currentMatchCount}/${activeSeason.maxGames} matches`);
    }

    // Handle image uploads if present
    let homeTeamImage: string | null = null;
    let awayTeamImage: string | null = null;

    if (files) {
      if (files.homeTeamImage && files.homeTeamImage[0]) {
        homeTeamImage = await uploadToCloudinary(files.homeTeamImage[0].buffer);
      }
      if (files.awayTeamImage && files.awayTeamImage[0]) {
        awayTeamImage = await uploadToCloudinary(files.awayTeamImage[0].buffer);
      }
    }

    // Create match with seasonId from active season
    const match = await Match.create({
      leagueId,
      seasonId: activeSeason.id, // 🔥 Always assign to active season
      date: new Date(date),
      start: new Date(start),
      end: new Date(end),
      location: location || '',
      homeTeamName: homeTeamName || 'Home Team',
      awayTeamName: awayTeamName || 'Away Team',
      homeTeamImage,
      awayTeamImage,
      notes: notes || null,
      status: 'SCHEDULED',
      homeTeamGoals: 0,
      awayTeamGoals: 0,
      homeCaptainId: homeCaptain || null,
      awayCaptainId: awayCaptain || null
    } as any);

    console.log(`✅ Match ${match.id} created in Season ${activeSeason.seasonNumber}`);

    // Handle team assignments if provided
    if (parsedHomeIds.length > 0) {
      await (match as any).setHomeTeamUsers(parsedHomeIds);
    }

    if (parsedAwayIds.length > 0) {
      await (match as any).setAwayTeamUsers(parsedAwayIds);
    }

    if (parsedHomeIds.length > 0 || parsedAwayIds.length > 0) {
      try {
        const prediction = await computeTeamWinPercentages({
          homeIds: parsedHomeIds,
          awayIds: parsedAwayIds,
          homeTotal: parsedHomeIds.length,
          awayTotal: parsedAwayIds.length,
        });
        await (match as any).update({
          homeWinPct: prediction.homeWinPct,
          awayWinPct: prediction.awayWinPct,
        });
      } catch (predictionErr) {
        console.warn('Could not snapshot match team-balance on create:', predictionErr);
      }
    }

    // Clear league cache
    try {
      cache.clearPattern(`league_${leagueId}`);
      cache.clearPattern(`matches_league_${leagueId}`);
    } catch (e) {
      console.warn('Cache clear failed', e);
    }

    // Send MATCH_CREATED notifications to all league members
    try {
      const leagueWithMembers = await League.findByPk(leagueId, {
        include: [{ model: User, as: 'members', attributes: ['id'] }]
      });

      const members = (leagueWithMembers as any)?.members || [];
      const currentUserId = ctx.state.user.userId;

      // Get match number in this season using visible (non-archived) sequence order.
      const seasonMatches = await Match.findAll({
        where: {
          leagueId,
          seasonId: activeSeason.id,
          deleted: false,
          archived: { [Op.not]: true }
        },
        attributes: ['id', 'createdAt', 'date', 'start'],
        order: [['createdAt', 'ASC']]
      });
      const currentIdx = seasonMatches.findIndex((m: any) => String(m.id) === String(match.id));
      const matchCount = currentIdx >= 0 ? currentIdx + 1 : seasonMatches.length;

      const notificationsToCreate = members
        .filter((member: any) => member.id !== currentUserId)
        .map((member: any) => ({
          user_id: member.id,
          type: 'MATCH_CREATED',
          title: `New Match Scheduled!`,
          body: `Match ${matchCount} has been scheduled for ${league.name}`,
          meta: {
            matchId: match.id,
            leagueId: leagueId,
            leagueName: league.name,
            matchNumber: matchCount,
            seasonId: activeSeason.id,
            seasonNumber: activeSeason.seasonNumber,
            date: match.date,
            start: match.start,
            end: match.end,
            location: match.location
          },
          read: false,
          created_at: new Date()
        }));

      if (notificationsToCreate.length > 0) {
        await Notification.bulkCreate(notificationsToCreate);
        console.log(`📢 Sent MATCH_CREATED notifications to ${notificationsToCreate.length} members`);
      }
    } catch (notifError) {
      console.warn('Failed to send match notifications:', notifError);
    }

    ctx.status = 201;
    ctx.body = {
      success: true,
      match: {
        id: match.id,
        leagueId: match.leagueId,
        seasonId: (match as any).seasonId,
        date: match.date,
        start: (match as any).start,
        end: (match as any).end,
        location: match.location,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        homeTeamImage: (match as any).homeTeamImage,
        awayTeamImage: (match as any).awayTeamImage,
        notes: (match as any).notes,
        status: match.status,
        seasonNumber: activeSeason.seasonNumber
      },
      message: `Match created in Season ${activeSeason.seasonNumber}`
    };
  } catch (err) {
    console.error('Create match in league error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to create match' };
  }
};

// Update match in league
export const updateMatchInLeague = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const { id: leagueId, matchId } = ctx.params;
  const currentUserId = ctx.state.user.userId;
  
  // Get form data
  const body = ctx.request.body as any;
  const files = (ctx.request as any).files as any;

  const {
    homeTeamName,
    awayTeamName,
    date,
    start,
    end,
    location,
    notes,
    homeTeamUsers,
    awayTeamUsers,
    homeGuests,
    awayGuests,
    homeCaptainId,
    awayCaptainId,
    notifyOnly,
    notificationMessage
  } = body;
  const normalizedNotes = typeof notes === 'string' ? notes.trim().slice(0, 50) : notes;
  const normalizedNotificationMessage = typeof notificationMessage === 'string'
    ? notificationMessage.trim().slice(0, 50)
    : '';

  let homeIds: string[] = [];
  let awayIds: string[] = [];
  let homeGuestsData: any[] = [];
  let awayGuestsData: any[] = [];
  try {
    homeIds = parseJsonArrayField(homeTeamUsers, 'homeTeamUsers').map((id: unknown) => String(id));
    awayIds = parseJsonArrayField(awayTeamUsers, 'awayTeamUsers').map((id: unknown) => String(id));
    homeGuestsData = parseJsonArrayField(homeGuests, 'homeGuests');
    awayGuestsData = parseJsonArrayField(awayGuests, 'awayGuests');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid team payload';
    ctx.status = 400;
    ctx.body = { success: false, message };
    return;
  }

  console.log('📢 [SERVER] updateMatchInLeague called');
  console.log('📢 [SERVER] body keys:', Object.keys(body));
  console.log('📢 [SERVER] notificationMessage:', JSON.stringify(normalizedNotificationMessage));
  console.log('📢 [SERVER] homeTeamUsers:', homeTeamUsers);
  console.log('📢 [SERVER] awayTeamUsers:', awayTeamUsers);

  try {
    // Find the match
    const match = await Match.findOne({
      where: { id: matchId, leagueId },
      include: [
        { model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }
      ]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    // Check admin permission
    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(currentUserId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update matches');
      return;
    }

    // If notifyOnly is set, just notify players but don't save teams
    if (notifyOnly === 'true') {
      // TODO: Send notifications to selected players
      ctx.body = { success: true, message: 'Players notified', notifyOnly: true };
      return;
    }

    const teamUploadRequested =
      homeTeamUsers !== undefined ||
      awayTeamUsers !== undefined ||
      homeGuests !== undefined ||
      awayGuests !== undefined;
    if (teamUploadRequested) {
      const uniqueRegisteredPlayers = new Set<string>([...homeIds, ...awayIds]).size;
      const totalPlayers = uniqueRegisteredPlayers + homeGuestsData.length + awayGuestsData.length;
      const validationMessage = validateTeamUploadThresholds(uniqueRegisteredPlayers, totalPlayers);
      if (validationMessage) {
        ctx.status = 400;
        ctx.body = { success: false, message: validationMessage };
        return;
      }
    }

    // Handle image uploads if present
    let homeTeamImage: string | null = (match as any).homeTeamImage;
    let awayTeamImage: string | null = (match as any).awayTeamImage;

    if (files) {
      if (files.homeTeamImage && files.homeTeamImage[0]) {
        homeTeamImage = await uploadToCloudinary(files.homeTeamImage[0].buffer);
      }
      if (files.awayTeamImage && files.awayTeamImage[0]) {
        awayTeamImage = await uploadToCloudinary(files.awayTeamImage[0].buffer);
      }
    }

    // Update match fields
    const updateData: any = {};
    if (homeTeamName !== undefined) updateData.homeTeamName = homeTeamName;
    if (awayTeamName !== undefined) updateData.awayTeamName = awayTeamName;
    if (date) updateData.date = new Date(date);
    if (start) updateData.start = new Date(start);
    if (end) updateData.end = new Date(end);
    if (location !== undefined) updateData.location = location;
    if (notes !== undefined) updateData.notes = normalizedNotes;
    if (homeTeamImage) updateData.homeTeamImage = homeTeamImage;
    if (awayTeamImage) updateData.awayTeamImage = awayTeamImage;
    if (homeCaptainId !== undefined) updateData.homeCaptainId = homeCaptainId || null;
    if (awayCaptainId !== undefined) updateData.awayCaptainId = awayCaptainId || null;

    await match.update(updateData);

    // Update team associations
    if (homeIds.length > 0 || awayIds.length > 0) {
      // Clear existing team associations
      await (match as any).setHomeTeamUsers([]);
      await (match as any).setAwayTeamUsers([]);

      // Set new team associations
      if (homeIds.length > 0) {
        await (match as any).setHomeTeamUsers(homeIds);
      }
      if (awayIds.length > 0) {
        await (match as any).setAwayTeamUsers(awayIds);
      }
    }

    // Delete existing guests for this match
    await MatchGuest.destroy({ where: { matchId } });

    // Create new guests
    const allGuests = [
      ...homeGuestsData.map((g: any) => ({ ...g, matchId, team: 'home' })),
      ...awayGuestsData.map((g: any) => ({ ...g, matchId, team: 'away' }))
    ];

    if (allGuests.length > 0) {
      await MatchGuest.bulkCreate(allGuests);
    }

    if (teamUploadRequested && !isFinalizedMatchStatus((match as any).status)) {
      try {
        const prediction = await computeTeamWinPercentages({
          homeIds,
          awayIds,
          homeTotal: homeIds.length + homeGuestsData.length,
          awayTotal: awayIds.length + awayGuestsData.length,
        });
        await match.update({
          homeWinPct: prediction.homeWinPct,
          awayWinPct: prediction.awayWinPct,
        } as any);
      } catch (predictionErr) {
        console.warn('Could not snapshot match team-balance on update:', predictionErr);
      }
    }

    // Send notification message to all match players if provided
    let notificationsSent = 0;
    console.log('📢 [SERVER] Checking notification - notificationMessage:', JSON.stringify(normalizedNotificationMessage));
    console.log('📢 [SERVER] notificationMessage truthy?', !!normalizedNotificationMessage);
    console.log('📢 [SERVER] notificationMessage trim?', normalizedNotificationMessage || 'N/A');
    
    if (normalizedNotificationMessage) {
      console.log('📢 [SERVER] INSIDE notification block - will send notifications');
      try {
        // Collect all unique player IDs from both teams
        const allPlayerIds = new Set<string>();
        homeIds.forEach((id: string) => allPlayerIds.add(id));
        awayIds.forEach((id: string) => allPlayerIds.add(id));

        console.log('📢 [SERVER] All player IDs:', Array.from(allPlayerIds));
        console.log('📢 [SERVER] Current user (admin):', currentUserId);

        // Send to ALL players including admin
        console.log('📢 [SERVER] Player IDs (including admin):',  Array.from(allPlayerIds));
        console.log('📢 [SERVER] Players to notify:', allPlayerIds.size);

        if (allPlayerIds.size > 0) {
          const league = (match as any).league;
          const leagueName = league?.name || 'League';

          const notificationsToCreate = Array.from(allPlayerIds).map(playerId => ({
            user_id: playerId,
            type: 'MATCH_NOTIFICATION',
            title: `Match Update - ${leagueName}`,
            body: normalizedNotificationMessage,
            meta: {
              matchId: matchId,
              leagueId: leagueId,
              leagueName: leagueName,
              sentBy: currentUserId,
              homeTeamName: homeTeamName || match.homeTeamName,
              awayTeamName: awayTeamName || match.awayTeamName,
              matchDate: date || match.date
            },
            read: false,
            created_at: new Date()
          }));

          await Notification.bulkCreate(notificationsToCreate);
          notificationsSent = notificationsToCreate.length;
          console.log(`📢 Sent match notification to ${notificationsSent} players: "${normalizedNotificationMessage}"`);
        }
      } catch (notifError) {
        console.warn('Failed to send match notification:', notifError);
      }
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        leagueId: match.leagueId,
        date: match.date,
        start: (match as any).start,
        end: (match as any).end,
        location: match.location,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        homeTeamImage: (match as any).homeTeamImage,
        awayTeamImage: (match as any).awayTeamImage,
        notes: (match as any).notes,
        status: match.status
      },
      message: notificationsSent > 0 ? `Match updated & notification sent to ${notificationsSent} players` : 'Match updated successfully',
      notificationsSent
    };
  } catch (err) {
    console.error('Update match in league error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update match' };
  }
};

// Get league-wide player averages (for career page influence radar & charts)
export const getLeaguePlayerAverages = async (ctx: Context) => {
  const { id } = ctx.params;
  const seasonIdRaw = typeof ctx.query.seasonId === 'string' ? ctx.query.seasonId.trim() : '';
  const yearRaw = typeof ctx.query.year === 'string' ? ctx.query.year.trim() : '';
  const selectedSeasonId = seasonIdRaw && seasonIdRaw !== 'all' && isUuid(seasonIdRaw) ? seasonIdRaw : '';
  const selectedYearFromSeason = !selectedSeasonId && /^year-\d{4}$/i.test(seasonIdRaw)
    ? Number(seasonIdRaw.replace(/^year-/i, ''))
    : null;
  const selectedYear = yearRaw && yearRaw !== 'all'
    ? Number(yearRaw)
    : selectedYearFromSeason;

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  try {
    const matchWhere: any = {
      leagueId: id,
      status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
    };
    if (selectedSeasonId) {
      matchWhere.seasonId = selectedSeasonId;
    }

    // Get all completed matches in this league/scope
    let completedMatches = await Match.findAll({
      where: matchWhere,
      attributes: ['id', 'date', 'seasonId', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId'],
      raw: true,
    }) as any[];

    if (Number.isFinite(selectedYear) && selectedYear) {
      completedMatches = completedMatches.filter((match: any) => {
        const matchYear = new Date(match.date).getFullYear();
        return matchYear === selectedYear;
      });
    }

    const matchIds = completedMatches.map((m: any) => m.id);

    if (matchIds.length === 0) {
      ctx.body = {
        success: true,
        totalMatches: 0,
        totalPlayers: 0,
        leagueAvg: { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0, defensiveImpactVotes: 0, impact: 0 },
        leagueTotals: { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0, defensiveImpactVotes: 0, impact: 0 },
        playerShares: {},
        playerTotals: {},
        players: {}
      };
      return;
    }

    // Get all match statistics for these matches
    const allStats = await MatchStatistics.findAll({
      where: { match_id: { [Op.in]: matchIds } },
      attributes: ['user_id', 'goals', 'assists', 'cleanSheets', 'defence', 'impact'],
      raw: true
    }) as any[];

    // Get MOTM vote counts per player for these matches
    const motmVotes = await (Vote as any).findAll({
      where: { matchId: { [Op.in]: matchIds } },
      attributes: ['votedForId'],
      raw: true
    }) as any[];

    // Count defensive impact votes per player from match fields
    const defImpactVoteMap: Record<string, number> = {};
    for (const m of completedMatches as any[]) {
      if (m.homeDefensiveImpactId) {
        const uid = String(m.homeDefensiveImpactId);
        defImpactVoteMap[uid] = (defImpactVoteMap[uid] || 0) + 1;
      }
      if (m.awayDefensiveImpactId) {
        const uid = String(m.awayDefensiveImpactId);
        defImpactVoteMap[uid] = (defImpactVoteMap[uid] || 0) + 1;
      }
    }

    // Collect all candidate user IDs to filter out guests
    const candidateUserIds = [...new Set([
      ...allStats.map((s: any) => String(s.user_id)),
      ...motmVotes.map((v: any) => String(v.votedForId)),
      ...Object.keys(defImpactVoteMap)
    ].filter((id) => id && id.trim() !== ''))];

    const nonGuests = await User.findAll({
      where: {
        id: { [Op.in]: candidateUserIds },
        ...registeredUserWhere()
      } as any,
      attributes: ['id'],
      raw: true
    });
    const nonGuestUserIds = new Set(nonGuests.map((u: any) => String(u.id)));

    // Build per-player aggregations (excluding guests)
    const playerMap: Record<string, { goals: number; assists: number; cleanSheets: number; defence: number; impact: number; motmVotes: number; defensiveImpactVotes: number; matches: number }> = {};
    const ensurePlayerStats = (uid: string) => {
      if (!nonGuestUserIds.has(uid)) return null;
      if (!playerMap[uid]) {
        playerMap[uid] = { goals: 0, assists: 0, cleanSheets: 0, defence: 0, impact: 0, motmVotes: 0, defensiveImpactVotes: 0, matches: 0 };
      }
      return playerMap[uid];
    };

    for (const stat of allStats) {
      const uid = String(stat.user_id);
      const playerStats = ensurePlayerStats(uid);
      if (!playerStats) continue;
      playerStats.goals += Number(stat.goals) || 0;
      playerStats.assists += Number(stat.assists) || 0;
      playerStats.cleanSheets += Number(stat.cleanSheets) || 0;
      playerStats.defence += Number(stat.defence) || 0;
      playerStats.impact += Number(stat.impact) || 0;
      playerStats.matches += 1;
    }

    // Add MOTM votes
    for (const vote of motmVotes) {
      const uid = String(vote.votedForId);
      if (!uid) continue;
      const playerStats = ensurePlayerStats(uid);
      if (playerStats) playerStats.motmVotes += 1;
    }

    // Add defensive impact votes
    for (const [uid, count] of Object.entries(defImpactVoteMap)) {
      if (!uid) continue;
      const playerStats = ensurePlayerStats(uid);
      if (playerStats) playerStats.defensiveImpactVotes += count;
    }

    // Calculate league-wide averages (per match per player) and contribution shares.
    // Share formula per metric: (player filtered total / all players filtered total) * 100.
    const playerIds = Object.keys(playerMap);
    const totalPlayers = playerIds.length;

    const leagueTotals = playerIds.reduce((acc, uid) => {
      const p = playerMap[uid];
      acc.goals += p.goals;
      acc.assists += p.assists;
      acc.cleanSheets += p.cleanSheets;
      acc.defence += p.defence;
      acc.motmVotes += p.motmVotes;
      acc.defensiveImpactVotes += p.defensiveImpactVotes;
      acc.impact += p.impact;
      acc.matches += p.matches;
      return acc;
    }, { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0, defensiveImpactVotes: 0, impact: 0, matches: 0 });

    const percentShare = (value: number, total: number): number => {
      if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0 || value <= 0) return 0;
      return Math.round((value / total) * 100);
    };

    const playersResult: Record<string, any> = {};
    const playerShares: Record<string, any> = {};
    const playerTotals: Record<string, any> = {};
    for (const uid of playerIds) {
      const p = playerMap[uid];
      const mc = Math.max(p.matches, 1);
      const avg = {
        goals: +(p.goals / mc).toFixed(2),
        assists: +(p.assists / mc).toFixed(2),
        cleanSheets: +(p.cleanSheets / mc).toFixed(2),
        defence: +(p.defence / mc).toFixed(2),
        impact: +(p.impact / mc).toFixed(2),
        motmVotes: +(p.motmVotes / mc).toFixed(2),
        defensiveImpactVotes: +(p.defensiveImpactVotes / mc).toFixed(2),
        matches: p.matches
      };
      playersResult[uid] = avg;
      playerTotals[uid] = {
        goals: p.goals,
        assists: p.assists,
        cleanSheets: p.cleanSheets,
        defence: p.defence,
        motmVotes: p.motmVotes,
        defensiveImpactVotes: p.defensiveImpactVotes,
        impact: p.impact,
        matches: p.matches,
      };
      playerShares[uid] = {
        goals: percentShare(p.goals, leagueTotals.goals),
        assists: percentShare(p.assists, leagueTotals.assists),
        cleanSheets: percentShare(p.cleanSheets, leagueTotals.cleanSheets),
        defence: percentShare(p.defence, leagueTotals.defence),
        motmVotes: percentShare(p.motmVotes, leagueTotals.motmVotes),
        defensiveImpactVotes: percentShare(p.defensiveImpactVotes, leagueTotals.defensiveImpactVotes),
        impact: percentShare(p.impact, leagueTotals.impact),
        matches: p.matches,
      };
    }

    const divider = Math.max(totalPlayers, 1);
    // Product rule for the dashboard Goals comparison: average (total goals + player appearances)
    // across registered league players, excluding migrated guests.
    const leagueAvg = {
      goals: +((leagueTotals.goals + leagueTotals.matches) / divider).toFixed(2),
      assists: +(leagueTotals.assists / divider).toFixed(2),
      cleanSheets: +(leagueTotals.cleanSheets / divider).toFixed(2),
      defence: +(leagueTotals.defence / divider).toFixed(2),
      motmVotes: +(leagueTotals.motmVotes / divider).toFixed(2),
      defensiveImpactVotes: +(leagueTotals.defensiveImpactVotes / divider).toFixed(2),
      impact: +(leagueTotals.impact / divider).toFixed(2)
    };

    ctx.body = {
      success: true,
      totalMatches: matchIds.length,
      totalPlayers,
      leagueAvg,
      leagueTotals,
      playerShares,
      playerTotals,
      players: playersResult
    };
  } catch (err) {
    console.error('Get league player averages error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch league player averages' };
  }
};

// Export all functions
export {
  // Match creation in league context is handled in matchController
  // but route delegation might still be here
};


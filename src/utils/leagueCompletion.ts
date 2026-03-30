/**
 * League Completion Logic
 *
 * A league season is "completed" when:
 *   - The season has a maxGames value > 0
 *   - The number of RESULT_PUBLISHED matches in that season >= maxGames
 *   - AND the last 2 completed matches have ALL players' stats submitted
 *
 * A league is "completed" when:
 *   - ALL seasons that have maxGames set have reached their maxGames limit
 *   - OR the active season has completed all its matches
 *   - AND the last 2 matches have full stats coverage
 */

import { Op, QueryTypes } from 'sequelize';
import models from '../models';
import Season from '../models/Season';
import MatchStatistics from '../models/MatchStatistics';
import Notification from '../models/Notification';

const { Match, League, User } = models;

// Statuses that count as "completed" matches
const COMPLETED_STATUSES = ['RESULT_PUBLISHED', 'RESULT_UPLOADED'];
const LEAGUE_COMPLETION_CACHE_TTL_MS = Number(process.env.LEAGUE_COMPLETION_CACHE_TTL_MS || 15000);

export interface SeasonCompletionInfo {
  seasonId: string;
  seasonNumber: number;
  seasonName: string;
  isActive: boolean;
  maxGames: number;
  completedMatches: number;
  isCompleted: boolean;
  last2MatchesStatsComplete: boolean;
  missingStatsPlayers: string[]; // player IDs who haven't submitted stats in last 2 matches
}

export interface LeagueCompletionInfo {
  leagueId: string;
  isCompleted: boolean;
  seasons: SeasonCompletionInfo[];
  activeSeasonCompleted: boolean;
  totalCompletedMatches: number;
  totalMaxGames: number;
  allStatsSubmitted: boolean;
  missing: string[]; // descriptions of what's missing
}

type LeagueCompletionCacheEntry = {
  value: LeagueCompletionInfo;
  expiresAt: number;
};

type CheckLeagueCompletionOptions = {
  bypassCache?: boolean;
};

const leagueCompletionCache = new Map<string, LeagueCompletionCacheEntry>();

const getMatchStatisticsTableName = (): string => {
  const rawTable = MatchStatistics.getTableName() as string | { tableName?: string };
  return typeof rawTable === 'string' ? rawTable : (rawTable.tableName || 'MatchStatistics');
};

const MATCH_STATISTICS_TABLE = getMatchStatisticsTableName().replace(/"/g, '""');

const getCachedLeagueCompletion = (leagueId: string): LeagueCompletionInfo | null => {
  const entry = leagueCompletionCache.get(leagueId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    leagueCompletionCache.delete(leagueId);
    return null;
  }
  return entry.value;
};

const setCachedLeagueCompletion = (leagueId: string, value: LeagueCompletionInfo): void => {
  leagueCompletionCache.set(leagueId, {
    value,
    expiresAt: Date.now() + LEAGUE_COMPLETION_CACHE_TTL_MS,
  });
};

export const invalidateLeagueCompletionCache = (leagueId?: string): void => {
  if (leagueId) {
    leagueCompletionCache.delete(String(leagueId));
    return;
  }
  leagueCompletionCache.clear();
};

/**
 * Slow fallback path used only if optimized SQL path fails.
 */
const checkMatchStatsCompleteSlow = async (matchId: string): Promise<{ allSubmitted: boolean; missingPlayerIds: string[] }> => {
  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id'] },
    ],
  });

  if (!match) return { allSubmitted: true, missingPlayerIds: [] };

  const allPlayerIds: string[] = [
    ...((match as any).homeTeamUsers || []).map((u: any) => String(u.id)),
    ...((match as any).awayTeamUsers || []).map((u: any) => String(u.id)),
  ];

  if (allPlayerIds.length === 0) return { allSubmitted: true, missingPlayerIds: [] };

  const stats = await MatchStatistics.findAll({
    where: { match_id: matchId },
    attributes: ['user_id'],
    raw: true,
  });

  const submittedPlayerIds = new Set(stats.map((s: any) => String(s.user_id)));
  const missingPlayerIds = allPlayerIds.filter(pid => !submittedPlayerIds.has(pid));

  return {
    allSubmitted: missingPlayerIds.length === 0,
    missingPlayerIds,
  };
};

const getLastCompletedMatchIds = async (seasonId: string, n: number): Promise<string[]> => {
  const lastMatches = await Match.findAll({
    where: {
      seasonId,
      status: { [Op.in]: COMPLETED_STATUSES },
    },
    order: [['date', 'DESC'], ['createdAt', 'DESC']],
    limit: n,
    attributes: ['id'],
    raw: true,
  });

  return lastMatches.map((m: any) => String(m.id));
};

const getMissingStatsPlayersForMatches = async (matchIds: string[]): Promise<string[]> => {
  if (!matchIds.length) return [];

  const sequelize = Match.sequelize!;
  const rows = await sequelize.query<{ userId: string }>(
    `
      WITH team_players AS (
        SELECT uhm."matchId" AS "matchId", uhm."userId" AS "userId"
        FROM "UserHomeMatches" uhm
        WHERE uhm."matchId" IN (:matchIds)

        UNION

        SELECT uam."matchId" AS "matchId", uam."userId" AS "userId"
        FROM "UserAwayMatches" uam
        WHERE uam."matchId" IN (:matchIds)
      ),
      submitted AS (
        SELECT ms.match_id AS "matchId", ms.user_id AS "userId"
        FROM "${MATCH_STATISTICS_TABLE}" ms
        WHERE ms.match_id IN (:matchIds)
      )
      SELECT DISTINCT tp."userId"::text AS "userId"
      FROM team_players tp
      LEFT JOIN submitted s
        ON s."matchId" = tp."matchId"
       AND s."userId" = tp."userId"
      WHERE s."userId" IS NULL
    `,
    {
      replacements: { matchIds },
      type: QueryTypes.SELECT,
    }
  );

  return rows.map((r) => String(r.userId));
};

/**
 * Check if the last N completed matches in a season have all player stats submitted.
 */
const checkLastNMatchesStatsComplete = async (seasonId: string, n: number = 2): Promise<{
  allComplete: boolean;
  missingPlayerIds: string[];
}> => {
  const matchIds = await getLastCompletedMatchIds(seasonId, n);
  if (matchIds.length === 0) return { allComplete: true, missingPlayerIds: [] };

  try {
    const missingPlayerIds = await getMissingStatsPlayersForMatches(matchIds);
    return {
      allComplete: missingPlayerIds.length === 0,
      missingPlayerIds: [...new Set(missingPlayerIds)],
    };
  } catch (err) {
    // Keep a robust fallback for mixed deployments with unexpected table naming.
    console.warn('[leagueCompletion] Fast stats completeness check failed. Falling back to safe mode.', err);

    const allMissing: string[] = [];
    let allComplete = true;

    for (const matchId of matchIds) {
      const result = await checkMatchStatsCompleteSlow(matchId);
      if (!result.allSubmitted) {
        allComplete = false;
        allMissing.push(...result.missingPlayerIds);
      }
    }

    return {
      allComplete,
      missingPlayerIds: [...new Set(allMissing)],
    };
  }
};

const getCompletedMatchCountsBySeason = async (
  leagueId: string,
  seasonIds: string[]
): Promise<Map<string, number>> => {
  const countsBySeason = new Map<string, number>();
  if (!seasonIds.length) return countsBySeason;

  const sequelize = Match.sequelize!;
  const rows = await sequelize.query<{ seasonId: string; completedCount: number }>(
    `
      SELECT "seasonId", COUNT(*)::int AS "completedCount"
      FROM "Matches"
      WHERE "leagueId" = :leagueId
        AND "seasonId" IN (:seasonIds)
        AND status IN (:completedStatuses)
      GROUP BY "seasonId"
    `,
    {
      replacements: {
        leagueId,
        seasonIds,
        completedStatuses: COMPLETED_STATUSES,
      },
      type: QueryTypes.SELECT,
    }
  );

  rows.forEach((row) => {
    countsBySeason.set(String(row.seasonId), Number(row.completedCount) || 0);
  });

  return countsBySeason;
};

/**
 * Check if a specific season is completed.
 * Season completed = maxGames reached AND last 2 matches have all stats submitted.
 */
export const isSeasonCompleted = async (seasonId: string): Promise<SeasonCompletionInfo | null> => {
  const season = await Season.findByPk(seasonId);
  if (!season) return null;

  const maxGames = Number(season.maxGames ?? 0);
  if (maxGames <= 0) {
    return {
      seasonId: season.id,
      seasonNumber: season.seasonNumber,
      seasonName: season.name,
      isActive: season.isActive,
      maxGames: 0,
      completedMatches: 0,
      isCompleted: false, // No maxGames set = never auto-complete
      last2MatchesStatsComplete: false,
      missingStatsPlayers: [],
    };
  }

  const completedCount = await Match.count({
    where: {
      seasonId,
      status: { [Op.in]: COMPLETED_STATUSES },
    },
  });

  const matchesReached = completedCount >= maxGames;

  let statsCheck = { allComplete: true, missingPlayerIds: [] as string[] };
  if (matchesReached) {
    statsCheck = await checkLastNMatchesStatsComplete(seasonId, 2);
    if (!statsCheck.allComplete) {
      console.log(`Season "${season.name}" matches reached (${completedCount}/${maxGames}) but last 2 matches missing stats from ${statsCheck.missingPlayerIds.length} players`);
    }
  }

  return {
    seasonId: season.id,
    seasonNumber: season.seasonNumber,
    seasonName: season.name,
    isActive: season.isActive,
    maxGames,
    completedMatches: completedCount,
    isCompleted: matchesReached && statsCheck.allComplete,
    last2MatchesStatsComplete: statsCheck.allComplete,
    missingStatsPlayers: statsCheck.missingPlayerIds,
  };
};

/**
 * Check if a league is completed based on its seasons.
 */
export const checkLeagueCompletion = async (
  leagueId: string,
  options: CheckLeagueCompletionOptions = {}
): Promise<LeagueCompletionInfo> => {
  const leagueKey = String(leagueId);

  if (!options.bypassCache) {
    const cached = getCachedLeagueCompletion(leagueKey);
    if (cached) return cached;
  }

  const seasons = await Season.findAll({
    where: { leagueId: leagueKey },
    order: [['seasonNumber', 'ASC']],
  });

  const seasonIds = seasons.map((season) => String(season.id));
  const completedCountBySeason = await getCompletedMatchCountsBySeason(leagueKey, seasonIds);

  const seasonInfos: SeasonCompletionInfo[] = [];
  let totalCompletedMatches = 0;
  let totalMaxGames = 0;
  let activeSeasonCompleted = false;
  let allStatsSubmitted = true;
  const missing: string[] = [];

  for (const season of seasons) {
    const maxGames = Number(season.maxGames ?? 0);

    let completedCount = 0;
    let statsCheck = { allComplete: true, missingPlayerIds: [] as string[] };

    if (maxGames > 0) {
      completedCount = completedCountBySeason.get(String(season.id)) || 0;

      if (completedCount >= maxGames) {
        statsCheck = await checkLastNMatchesStatsComplete(season.id, 2);
      }
    }

    const matchesReached = maxGames > 0 && completedCount >= maxGames;
    const isCompleted = matchesReached && statsCheck.allComplete;

    if (season.isActive && isCompleted) {
      activeSeasonCompleted = true;
    }

    if (matchesReached && !statsCheck.allComplete) {
      allStatsSubmitted = false;
      missing.push(`Season "${season.name}": ${statsCheck.missingPlayerIds.length} player(s) haven't submitted stats in last 2 matches`);
    }

    totalCompletedMatches += completedCount;
    totalMaxGames += maxGames;

    seasonInfos.push({
      seasonId: season.id,
      seasonNumber: season.seasonNumber,
      seasonName: season.name,
      isActive: season.isActive,
      maxGames,
      completedMatches: completedCount,
      isCompleted,
      last2MatchesStatsComplete: statsCheck.allComplete,
      missingStatsPlayers: statsCheck.missingPlayerIds,
    });
  }

  const seasonsWithMaxGames = seasonInfos.filter(s => s.maxGames > 0);
  const allSeasonsCompleted = seasonsWithMaxGames.length > 0 && seasonsWithMaxGames.every(s => s.isCompleted);
  const isCompleted = activeSeasonCompleted || allSeasonsCompleted;

  if (isCompleted) {
    const league = await League.findByPk(leagueKey, { attributes: ['id', 'active'] });
    if (league && league.active) {
      await League.update({ active: false }, { where: { id: leagueKey } });
      console.log(`League ${leagueKey} auto-marked as inactive (completed)`);
    }
  }

  const result: LeagueCompletionInfo = {
    leagueId: leagueKey,
    isCompleted,
    seasons: seasonInfos,
    activeSeasonCompleted,
    totalCompletedMatches,
    totalMaxGames,
    allStatsSubmitted,
    missing,
  };

  setCachedLeagueCompletion(leagueKey, result);
  return result;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  if (!items.length) return results;

  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
};

export const checkLeagueCompletionBulk = async (
  leagueIds: string[],
  options: CheckLeagueCompletionOptions = {}
): Promise<Record<string, LeagueCompletionInfo>> => {
  const uniqueLeagueIds = [...new Set((leagueIds || []).map((id) => String(id)).filter(Boolean))];
  if (!uniqueLeagueIds.length) return {};

  const infos = await mapWithConcurrency(
    uniqueLeagueIds,
    async (leagueId) => checkLeagueCompletion(leagueId, options),
    4
  );

  return uniqueLeagueIds.reduce<Record<string, LeagueCompletionInfo>>((acc, leagueId, idx) => {
    acc[leagueId] = infos[idx];
    return acc;
  }, {});
};

/**
 * After a match is published, check if its season is now complete,
 * and if so, mark the league as completed (active: false).
 * Also sends a notification to league members.
 */
export const checkAndCompleteLeagueAfterMatch = async (matchId: string): Promise<{
  seasonCompleted: boolean;
  leagueCompleted: boolean;
  seasonInfo: SeasonCompletionInfo | null;
}> => {
  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'seasonId', 'status'],
  });

  if (!match || !match.seasonId) {
    return { seasonCompleted: false, leagueCompleted: false, seasonInfo: null };
  }

  const seasonInfo = await isSeasonCompleted(match.seasonId);
  if (!seasonInfo || !seasonInfo.isCompleted) {
    return { seasonCompleted: false, leagueCompleted: false, seasonInfo };
  }

  console.log(`Season "${seasonInfo.seasonName}" completed! (${seasonInfo.completedMatches}/${seasonInfo.maxGames} matches)`);

  const leagueInfo = await checkLeagueCompletion(match.leagueId, { bypassCache: true });

  if (leagueInfo.isCompleted) {
    console.log(`League ${match.leagueId} is now COMPLETED! All season matches are done.`);

    try {
      const league = await League.findByPk(match.leagueId, {
        include: [{ model: User, as: 'members', attributes: ['id'] }],
      });

      if (league && (league as any).members) {
        const memberIds: string[] = (league as any).members.map((m: any) => String(m.id));
        const notifications = memberIds.map((userId: string) => ({
          user_id: userId,
          type: 'LEAGUE_COMPLETED',
          title: `League Completed!`,
          body: `All matches in "${league.name}" - ${seasonInfo.seasonName} have been completed! Check the Trophy Room for results.`,
          meta: {
            leagueId: match.leagueId,
            leagueName: league.name,
            seasonId: seasonInfo.seasonId,
            seasonName: seasonInfo.seasonName,
          },
          read: false,
          created_at: new Date(),
        }));

        await Notification.bulkCreate(notifications);
        console.log(`Sent league completion notification to ${memberIds.length} members`);
      }
    } catch (notifErr) {
      console.error('Failed to send league completion notification:', notifErr);
    }
  }

  return {
    seasonCompleted: seasonInfo.isCompleted,
    leagueCompleted: leagueInfo.isCompleted,
    seasonInfo,
  };
};

/**
 * Check if a league's points are locked (completed for more than 24 hours).
 * Uses the latest resultPublishedAt from completed matches as the completion time.
 * Returns { locked: boolean, hoursRemaining: number }
 */
export const isLeagueLocked = async (leagueId: string): Promise<{ locked: boolean; hoursRemaining: number }> => {
  try {
    const league = await League.findByPk(leagueId, { attributes: ['id', 'active'] });

    if (!league || league.active) {
      return { locked: false, hoursRemaining: 0 };
    }

    const sequelize = League.sequelize!;
    const result = await sequelize.query<{ latest: string }>(
      `SELECT MAX("updatedAt") as latest FROM "Matches" WHERE "leagueId" = $1 AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')`,
      { bind: [leagueId], type: QueryTypes.SELECT }
    );

    if (!result.length || !result[0].latest) {
      return { locked: false, hoursRemaining: 0 };
    }

    const completionTime = new Date(result[0].latest);
    const now = new Date();
    const hoursSinceCompletion = (now.getTime() - completionTime.getTime()) / (1000 * 60 * 60);

    if (hoursSinceCompletion >= 24) {
      return { locked: true, hoursRemaining: 0 };
    }

    return { locked: false, hoursRemaining: Math.ceil(24 - hoursSinceCompletion) };
  } catch (err) {
    console.error('Error checking league lock status:', err);
    return { locked: false, hoursRemaining: 0 };
  }
};

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

/**
 * Check if ALL players in a match have submitted their stats
 * Returns { allSubmitted, missingPlayerIds }
 */
const checkMatchStatsComplete = async (matchId: string): Promise<{ allSubmitted: boolean; missingPlayerIds: string[] }> => {
  // Get all players in the match (home + away)
  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName'] },
    ],
  });

  if (!match) return { allSubmitted: true, missingPlayerIds: [] };

  const allPlayerIds: string[] = [
    ...((match as any).homeTeamUsers || []).map((u: any) => String(u.id)),
    ...((match as any).awayTeamUsers || []).map((u: any) => String(u.id)),
  ];

  if (allPlayerIds.length === 0) return { allSubmitted: true, missingPlayerIds: [] };

  // Get all stats submissions for this match
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

/**
 * Check if the last N completed matches in a season have all player stats submitted
 */
const checkLastNMatchesStatsComplete = async (seasonId: string, n: number = 2): Promise<{
  allComplete: boolean;
  missingPlayerIds: string[];
}> => {
  // Get last N completed matches ordered by date DESC
  const lastMatches = await Match.findAll({
    where: {
      seasonId,
      status: { [Op.in]: COMPLETED_STATUSES },
    },
    order: [['date', 'DESC'], ['createdAt', 'DESC']],
    limit: n,
    attributes: ['id'],
  });

  if (lastMatches.length === 0) return { allComplete: true, missingPlayerIds: [] };

  const allMissing: string[] = [];
  let allComplete = true;

  for (const m of lastMatches) {
    const result = await checkMatchStatsComplete(String(m.id));
    if (!result.allSubmitted) {
      allComplete = false;
      allMissing.push(...result.missingPlayerIds);
    }
  }

  return {
    allComplete,
    missingPlayerIds: [...new Set(allMissing)], // unique player IDs
  };
};

/**
 * Check if a specific season is completed
 * Season completed = maxGames reached AND last 2 matches have all stats submitted
 */
export const isSeasonCompleted = async (seasonId: string): Promise<SeasonCompletionInfo | null> => {
  const season = await Season.findByPk(seasonId);
  if (!season) return null;

  const maxGames = season.maxGames ?? 0;
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

  // Check if last 2 completed matches have all player stats submitted
  let statsCheck = { allComplete: true, missingPlayerIds: [] as string[] };
  if (matchesReached) {
    statsCheck = await checkLastNMatchesStatsComplete(seasonId, 2);
    if (!statsCheck.allComplete) {
      console.log(`📊 Season "${season.name}" matches reached (${completedCount}/${maxGames}) but last 2 matches missing stats from ${statsCheck.missingPlayerIds.length} players`);
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
 * Check if a league is completed based on its seasons
 * A league is completed when:
 *   1. All seasons with maxGames have completed their matches (completedMatches >= maxGames)
 *   2. AND the last 2 matches of those seasons have all players' stats submitted
 */
export const checkLeagueCompletion = async (leagueId: string): Promise<LeagueCompletionInfo> => {
  const seasons = await Season.findAll({
    where: { leagueId },
    order: [['seasonNumber', 'ASC']],
  });

  const seasonInfos: SeasonCompletionInfo[] = [];
  let totalCompletedMatches = 0;
  let totalMaxGames = 0;
  let activeSeasonCompleted = false;
  let allStatsSubmitted = true;
  const missing: string[] = [];

  for (const season of seasons) {
    const maxGames = season.maxGames ?? 0;
    
    let completedCount = 0;
    let statsCheck = { allComplete: true, missingPlayerIds: [] as string[] };
    
    if (maxGames > 0) {
      completedCount = await Match.count({
        where: {
          seasonId: season.id,
          status: { [Op.in]: COMPLETED_STATUSES },
        },
      });

      // If matches target reached, check last 2 matches for stats
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

  // League is completed when the active season has completed all its matches AND stats
  const seasonsWithMaxGames = seasonInfos.filter(s => s.maxGames > 0);
  const allSeasonsCompleted = seasonsWithMaxGames.length > 0 && seasonsWithMaxGames.every(s => s.isCompleted);

  const isCompleted = activeSeasonCompleted || allSeasonsCompleted;

  // Auto-mark league as inactive when completed
  if (isCompleted) {
    const league = await League.findByPk(leagueId, { attributes: ['id', 'active'] });
    if (league && league.active) {
      await League.update({ active: false }, { where: { id: leagueId } });
      console.log(`🔒 League ${leagueId} auto-marked as inactive (completed)`);
    }
  }

  return {
    leagueId,
    isCompleted,
    seasons: seasonInfos,
    activeSeasonCompleted,
    totalCompletedMatches,
    totalMaxGames,
    allStatsSubmitted,
    missing,
  };
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

  // Check season completion
  const seasonInfo = await isSeasonCompleted(match.seasonId);
  if (!seasonInfo || !seasonInfo.isCompleted) {
    return { seasonCompleted: false, leagueCompleted: false, seasonInfo };
  }

  console.log(`🏆 Season "${seasonInfo.seasonName}" completed! (${seasonInfo.completedMatches}/${seasonInfo.maxGames} matches)`);

  // Check overall league completion
  const leagueInfo = await checkLeagueCompletion(match.leagueId);

  if (leagueInfo.isCompleted) {
    console.log(`🏆🏆 League ${match.leagueId} is now COMPLETED! All season matches are done.`);

    // active: false is already set by checkLeagueCompletion above

    // Send notification to all league members
    try {
      const league = await League.findByPk(match.leagueId, {
        include: [{ model: User, as: 'members', attributes: ['id'] }],
      });

      if (league && (league as any).members) {
        const memberIds: string[] = (league as any).members.map((m: any) => String(m.id));
        const notifications = memberIds.map((userId: string) => ({
          user_id: userId,
          type: 'LEAGUE_COMPLETED',
          title: `🏆 League Completed!`,
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
        console.log(`📢 Sent league completion notification to ${memberIds.length} members`);
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

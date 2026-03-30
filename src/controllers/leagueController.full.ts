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

const { League, Match, User, MatchGuest } = models;

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
  }));
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
      return {
        id: league.id,
        name: league.name,
        active: league.active,
        archived: league.archived,
        image: league.image,
        maxGames: league.maxGames,
        computedStatus: {
          isCompleted: Boolean(completionInfo?.isCompleted),
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
          teamGoalsConceded: 0
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
      // FAST PATH: fetch only the specific league directly (avoid loading ALL user leagues)
      const league = await League.findByPk(leagueIdQ, {
        attributes: ['id', 'name', 'maxGames'],
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'xp'] },
          {
            model: Match,
            as: 'matches',
            where: { status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] } },
            required: false,
            attributes: ['id', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals'],
            include: [
              { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
              { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] }
            ]
          }
        ]
      });
      if (!league) {
        ctx.body = { success: true, trophyWinners: [], backendTotalXP: 0 };
        return;
      }
      leagues = [league];
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
        attributes: ['id', 'name', 'maxGames'],
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'xp'] },
          {
            model: Match,
            as: 'matches',
            where: { status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] } },
            required: false,
            attributes: ['id', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals'],
            include: [
              { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
              { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] }
            ]
          }
        ]
      });
      leagues = fetchedLeagues || [];
    }

    // Fetch seasons separately (lightweight query, avoids timeout)
    const leagueIds = leagues.map((l: any) => String(l.id));
    const allSeasons = leagueIds.length > 0 ? await Season.findAll({
      where: { leagueId: { [Op.in]: leagueIds } },
      attributes: ['id', 'leagueId', 'seasonNumber', 'name', 'isActive', 'maxGames', 'showPoints'],
      raw: true,
    }) : [];
    const seasonsByLeague: Record<string, any[]> = {};
    (allSeasons || []).forEach((s: any) => {
      const lid = String(s.leagueId);
      if (!seasonsByLeague[lid]) seasonsByLeague[lid] = [];
      seasonsByLeague[lid].push(s);
    });

    const trophyWinners: any[] = [];

    // Fetch goals/assists from MatchStatistics and MOTM votes from Vote table
    const allMatchIds: string[] = [];
    leagues.forEach((l: any) => {
      (l.matches || []).forEach((m: any) => allMatchIds.push(String(m.id)));
    });
    if (allMatchIds.length > 0) {
      const [matchStatRows, voteRows] = await Promise.all([
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
      ]);
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
      
      if (seasonIdQ && seasonIdQ !== 'all') {
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === seasonIdQ);
        const season = seasons.find((s: any) => String(s.id) === seasonIdQ);
        currentSeasonName = season?.name || `Season ${season?.seasonNumber || 1}`;
        console.log(`🔍 [Trophy Room] Filtered ${matchesToUse.length} matches for season ${currentSeasonName}`);
      } else if (seasons.length > 0) {
        // Use active season if no specific season is selected
        const activeSeason = seasons.find((s: any) => s.isActive) || seasons[0];
        currentSeasonId = String(activeSeason.id);
        currentSeasonName = activeSeason.name || `Season ${activeSeason.seasonNumber}`;
        matchesToUse = allMatches.filter((m: any) => String(m.seasonId) === currentSeasonId);
        console.log(`🔍 [Trophy Room] Using active season ${currentSeasonName} with ${matchesToUse.length} matches`);
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
        return role === 'gk' || role.includes('goalkeeper');
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

      const nameMap = new Map<string, string>();
      (league.members || []).forEach((p: any) => {
        const pid = String(p.id);
        const nm = `${p.firstName || ''} ${p.lastName || ''}`.trim();
        if (pid && nm) nameMap.set(pid, nm);
      });
      (matchesToUse || []).forEach((m: any) => {
        [...(m.homeTeamUsers || []), ...(m.awayTeamUsers || [])].forEach((u: any) => {
          const pid = String(u.id);
          const nm = `${u.firstName || ''} ${u.lastName || ''}`.trim();
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
          winnerId: shieldCandidateIds.length > 0
            ? shieldCandidateIds.sort((a, b) => {
                const avgA = stats[a].teamGoalsConceded / stats[a].played;
                const avgB = stats[b].teamGoalsConceded / stats[b].played;
                return avgA - avgB;
              })[0] || null
            : null
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
            return Number.isFinite(s.teamGoalsConceded / s.played);
          case 'Dark Horse':
            return leagueTable.slice(3).includes(winnerId) && s.motmVotes > 0;
          case 'Star Keeper':
            return gkIds.includes(winnerId) && (cleanSheets[winnerId] || 0) > 0;
          default:
            return true;
        }
      };

      awards.forEach(award => {
        const rawWinnerId = award.winnerId ? String(award.winnerId) : null;
        const winnerId = rawWinnerId && meetsAwardRequirement(award.title, rawWinnerId) ? rawWinnerId : null;
        const winnerName = winnerId ? getPlayerName(winnerId) : '';
        const hasValidWinner = Boolean(winnerId && winnerName);
        trophyWinners.push({
          title: award.title,
          winnerId: hasValidWinner ? winnerId : null,
          winner: hasValidWinner ? winnerName : 'TBC',
          leagueId: String(league.id),
          leagueName: league.name,
          seasonId: currentSeasonId || undefined,
          seasonName: currentSeasonName || undefined,
        });
      });
    });

    console.log(`✅ [Trophy Room] Returning ${trophyWinners.length} trophy winners`);
    
    const trPayload = { 
      success: true, 
      trophyWinners,
      backendTotalXP: 0
    };
    cache.set(trCacheKey, trPayload, 120); // cache 2 minutes
    ctx.body = trPayload;
  } catch (err) {
    console.error('❌ [Trophy Room] Error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch trophy room' };
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
    const match = await Match.findByPk(matchId);
    if (!match) { ctx.status = 404; ctx.body = { success: false }; return; }

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
    const match = await Match.findByPk(matchId);
    if (!match) { ctx.status = 404; ctx.body = { success: false }; return; }

    const field = team === 'away' ? 'awayCaptainId' : 'homeCaptainId';
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
    const match = await Match.findOne({
      where: { id: matchId, leagueId: id },
    });
    if (!match) { ctx.status = 404; ctx.body = { success: false }; return; }

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
    const match = await Match.findOne({ where: { id: matchId, leagueId: id } });
    if (!match) { ctx.status = 404; ctx.body = { success: false }; return; }

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
        return {
          id: league.id,
          name: league.name,
          active: league.active,
          archived: league.archived,
          image: league.image,
          maxGames: league.maxGames,
          computedStatus: {
            isCompleted: Boolean(completionInfo?.isCompleted),
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

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    const league = await League.findByPk(id, {
      include: [
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber', 'style'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        {
          model: Season,
          as: 'seasons',
          attributes: ['id', 'seasonNumber', 'name', 'isActive', 'startDate', 'endDate', 'maxGames', 'showPoints', 'createdAt'],
          include: [
            {
              model: User,
              as: 'players',
              attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber', 'style'],
              through: { attributes: [] } // Don't include join table data
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

    const isMember = (league as any).members?.some((m: any) => String(m.id) === String(userId));
    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(userId));

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    // Find user's season (the season they are part of or haven't declined)
    const seasons = (league as any).seasons || [];
    let userSeasonId: string | null = null;

    // If user is ADMIN - show ALL seasons and ALL matches (frontend will filter)
    if (isAdmin) {
      const activeSeason = seasons.find((s: any) => s.isActive);
      userSeasonId = activeSeason?.id || (seasons.length > 0 ? seasons[0].id : null);

      // Fetch ALL matches for ALL seasons (admin can switch between seasons in frontend)
      const Vote = (await import('../models/Vote')).Vote;
      const matches = await Match.findAll({
        where: {
          leagueId: id
          // No seasonId filter - return ALL matches with their seasonIds
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

      ctx.body = {
        success: true,
        league: {
          id: league.id,
          name: league.name,
          inviteCode: league.inviteCode,
          active: league.active,
          archived: Boolean((league as any).archived),
          image: (league as any).image,
          maxGames: league.maxGames,
          members: (league as any).members || [],
          matches: matchesWithNumbers,
          seasons: formattedSeasons, // Admin sees ALL seasons with members
          currentSeason: activeSeason || (seasons.length > 0 ? seasons[0] : null), // Admin's current = active season
          administrators: (league as any).administeredLeagues || [],
          isAdmin,
          computedStatus
        }
      };
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
      const Notification = (await import('../models/Notification')).default;
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
    const Vote = (await import('../models/Vote')).Vote;
    
    // Get all season IDs user is a member of
    const userSeasonIds = seasons
      .filter((s: any) => {
        const seasonPlayers = s.players || [];
        return seasonPlayers.some((p: any) => String(p.id) === String(userId));
      })
      .map((s: any) => s.id);
    
    console.log(`📊 [MEMBER] User ${userId} is in seasons:`, userSeasonIds);
    
    const matches = await Match.findAll({
      where: {
        leagueId: id,
        seasonId: userSeasonIds.length > 0 ? userSeasonIds : null // Fetch matches for all user's seasons
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

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        inviteCode: league.inviteCode,
        active: league.active,
        archived: Boolean((league as any).archived),
        image: (league as any).image,
        maxGames: league.maxGames,
        members: (league as any).members || [],
        matches: matchesWithNumbers,
        seasons: filteredSeasons, // Only show seasons user is member of
        currentSeason: userCurrentSeason, // User's current season
        administrators: (league as any).administeredLeagues || [],
        isAdmin,
        computedStatus: computedStatusMember
      }
    };
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
          where: { isActive: true },
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

  try {
    const league = await League.findByPk(id, {
      include: [
        { model: User, as: 'members', attributes: ['id'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        {
          model: Season,
          as: 'seasons',
          where: { isActive: true },
          required: false
        }
      ]
    });

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    const isMember = (league as any).members?.some((m: any) => String(m.id) === String(userId));
    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(userId));

    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Access denied' };
      return;
    }

    const activeSeason = (league as any).seasons?.[0];
    const seasonId = querySeasonId || activeSeason?.id;

    // Canonical source of truth: match_statistics.xp_awarded
    // (already computed at stats submission time).
    const xpMap: Record<string, number> = {};
    const avgMap: Record<string, number> = {};
    const matchCountMap: Record<string, number> = {};
    const sequelize = League.sequelize!;

    const memberIds = ((league as any).members || []).map((m: any) => String(m.id));
    memberIds.forEach((uid: string) => {
      xpMap[uid] = 0;
      avgMap[uid] = 0;
      matchCountMap[uid] = 0;
    });

    try {
      // 1) Completed matches for this league (+ optional season filter)
      let matchQuery = `SELECT id FROM "Matches" WHERE "leagueId" = $1 AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')`;
      const matchBinds: any[] = [id];
      if (seasonId) {
        matchQuery += ` AND "seasonId" = $2`;
        matchBinds.push(seasonId);
      }

      const matches = await sequelize.query<{ id: string }>(matchQuery, {
        bind: matchBinds,
        type: QueryTypes.SELECT
      });

      if (matches.length === 0) {
        ctx.body = { success: true, xp: xpMap, avg: avgMap };
        return;
      }

      const matchIds = matches.map((m) => m.id);
      const matchIdPlaceholders = matchIds.map((_, i) => `$${i + 1}`).join(',');

      // 2) Real participants (exclude guests)
      const [homePlayers, awayPlayers] = await Promise.all([
        sequelize.query<{ userId: string }>(
          `SELECT "userId" FROM "UserHomeMatches" WHERE "matchId" IN (${matchIdPlaceholders})`,
          { bind: matchIds, type: QueryTypes.SELECT }
        ),
        sequelize.query<{ userId: string }>(
          `SELECT "userId" FROM "UserAwayMatches" WHERE "matchId" IN (${matchIdPlaceholders})`,
          { bind: matchIds, type: QueryTypes.SELECT }
        )
      ]);

      const participantIds = Array.from(new Set<string>([
        ...homePlayers.map((r) => String(r.userId)),
        ...awayPlayers.map((r) => String(r.userId))
      ]));

      if (participantIds.length === 0) {
        ctx.body = { success: true, xp: xpMap, avg: avgMap };
        return;
      }

      const participantPlaceholders = participantIds
        .map((_, i) => `$${matchIds.length + i + 1}`)
        .join(',');

      // 3) Aggregate canonical XP from match_statistics.xp_awarded
      const xpRows = await sequelize.query<{
        user_id: string;
        total_xp: number | string;
        match_count: number | string;
      }>(
        `SELECT
           ms.user_id,
           COALESCE(SUM(ms.xp_awarded), 0) AS total_xp,
           COUNT(DISTINCT ms.match_id) AS match_count
         FROM match_statistics ms
         WHERE ms.match_id IN (${matchIdPlaceholders})
           AND ms.user_id IN (${participantPlaceholders})
         GROUP BY ms.user_id`,
        { bind: [...matchIds, ...participantIds], type: QueryTypes.SELECT }
      );

      xpRows.forEach((row) => {
        const uid = String(row.user_id);
        const totalXP = Number(row.total_xp) || 0;
        const matchCount = Number(row.match_count) || 0;
        xpMap[uid] = totalXP;
        matchCountMap[uid] = matchCount;
        avgMap[uid] = matchCount > 0 ? Math.round(totalXP / matchCount) : 0;
      });

      participantIds.forEach((uid) => {
        if (xpMap[uid] == null) xpMap[uid] = 0;
        if (avgMap[uid] == null) avgMap[uid] = 0;
        if (matchCountMap[uid] == null) matchCountMap[uid] = 0;
      });
    } catch (statsErr) {
      console.error('Could not compute league XP:', statsErr);
    }

    ctx.body = {
      success: true,
      xp: xpMap,
      avg: avgMap
    };
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
    // Resolve seasonId: use query param if provided, otherwise find active season
    let seasonId = querySeasonId;
    if (!seasonId) {
      const activeSeason = await Season.findOne({
        where: { leagueId, isActive: true }
      });
      if (activeSeason) seasonId = String((activeSeason as any).id);
    }

    // Build match filter (league + optional season)
    const matchWhere: any = { leagueId };
    if (seasonId) matchWhere.seasonId = seasonId;

    // Count MOTM votes for this player in this league (filtered by season)
    const motmCount = await (Vote as any).count({
      include: [
        {
          model: Match,
          as: 'votedMatch',
          where: matchWhere,
          attributes: [],
          required: true
        }
      ],
      where: {
        votedForId: playerId
      }
    });

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

    ctx.body = {
      success: true,
      motmCount: motmCount || 0,
      lastFive,
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

    // Generate invite code
    const inviteCode = getInviteCode();

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
      isActive: true,
      startDate: new Date()
    } as any);

    // Add creator to Season 1
    if (creator) {
      await (season1 as any).addPlayer(creator);
    }

    cache.clearPattern(`user_leagues_${userId}`);

    ctx.status = 201;
    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        maxGames: league.maxGames,
        image: imageUrl,
        seasonId: season1.id
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
  const { active } = ctx.request.body as any;

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

    // Important: Boolean('false') === true, so parse explicitly.
    const isActive = active === true || active === 'true';
    // When admin marks league as inactive, also archive it
    const updateData: any = { active: isActive };
    if (!isActive) {
      updateData.archived = true;
      console.log(`📦 League "${league.name}" archived by admin (marked inactive)`);
    } else {
      // If reactivating, un-archive it
      updateData.archived = false;
    }

    await league.update(updateData);

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        active: league.active,
        archived: (league as any).archived
      }
    };
  } catch (err) {
    console.error('Update league status error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update league' };
  }
};

// Update league
export const updateLeague = async (ctx: Context) => {
  const { id } = ctx.params;
  const { name, maxGames, active, showPoints, removeImage, seasonId, seasonMaxGames, seasonShowPoints } = ctx.request.body as any;
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

    const updateData: any = {};
    if (name) updateData.name = name;
    if (maxGames !== undefined) updateData.maxGames = Number(maxGames);
    // Handle boolean fields that may arrive as strings from FormData
    if (active !== undefined) updateData.active = active === true || active === 'true';
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

      if (validAdminIds.length > 0) {
        // Replace all current admins with the new admin(s)
        await (league as any).setAdministeredLeagues(validAdminIds);
        console.log(`✅ League ${id} admin(s) updated to:`, validAdminIds);
      }
    }

    // Update season settings if provided (handled here to avoid separate request + admin re-check)
    if (seasonId) {
      const season = await Season.findByPk(seasonId);
      if (season) {
        if (seasonMaxGames !== undefined) season.maxGames = Number(seasonMaxGames);
        if (seasonShowPoints !== undefined) season.showPoints = seasonShowPoints === true || seasonShowPoints === 'true';
        await season.save();
        console.log(`✅ Season ${seasonId} settings updated: maxGames=${season.maxGames}, showPoints=${season.showPoints}`);
      }
    }

    // Fetch updated admin list
    const updatedLeague = await League.findByPk(id, {
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id', 'firstName', 'lastName'] }]
    });

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: (updatedLeague as any)?.name || league.name,
        maxGames: (updatedLeague as any)?.maxGames || league.maxGames,
        active: (updatedLeague as any)?.active ?? league.active,
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

// Delete league (soft-delete: archives the league, preserves all player XP)
export const deleteLeague = async (ctx: Context) => {
  const { id } = ctx.params;

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

    // Soft-delete: mark as inactive + archived so XP, stats, and match data are preserved
    await league.update({ active: false, archived: true });

    // Remove all members and admins from the league (they keep their XP)
    const members: any[] = (league as any).members || [];
    if (members.length > 0) {
      await (league as any).setMembers([]);
      await (league as any).setAdministeredLeagues([]);
    }

    // Notify all members the league was deleted
    try {
      const notifications = members.map((m: any) => ({
        user_id: String(m.id),
        type: 'LEAGUE_DELETED',
        title: '🗑️ League Deleted',
        body: `The league "${league.name}" has been deleted by the admin. Your XP points have been preserved.`,
        meta: {
          leagueId: id,
          leagueName: league.name,
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

    ctx.body = {
      success: true,
      message: 'League deleted successfully. All players\' XP points have been preserved.'
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

  if (!inviteCode) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'Please enter an invite code' };
    return;
  }

  try {
    const league = await League.findOne({
      where: { inviteCode },
      include: [
        { model: User, as: 'members', attributes: ['id'] },
        { model: Season, as: 'seasons', where: { isActive: true }, required: false }
      ]
    });

    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'No league found with this invite code. Please check and try again.' };
      return;
    }

    const isMember = (league as any).members?.some((m: any) => String(m.id) === String(userId));
    if (isMember) {
      ctx.status = 409;
      ctx.body = { success: false, message: 'You are already joined to this league' };
      return;
    }

    const user = await User.findByPk(userId);
    if (user) {
      await (league as any).addMember(user);

      // Add to active season
      const activeSeason = (league as any).seasons?.[0];
      if (activeSeason) {
        await (activeSeason as any).addPlayer(user);
      }
    }

    cache.clearPattern(`user_leagues_${userId}`);

    ctx.body = {
      success: true,
      message: 'Successfully joined league',
      league: {
        id: league.id,
        name: league.name
      }
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
    const Notification = (await import('../models/Notification')).default;
    
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

    // Find the ACTIVE season for this league
    const activeSeason = await Season.findOne({
      where: {
        leagueId,
        isActive: true
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

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  try {
    // Get all completed matches in this league
    const completedMatches = await Match.findAll({
      where: {
        leagueId: id,
        status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
      },
      attributes: ['id', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId']
    });

    const matchIds = completedMatches.map((m: any) => m.id);

    if (matchIds.length === 0) {
      ctx.body = {
        success: true,
        totalMatches: 0,
        totalPlayers: 0,
        leagueAvg: { goals: 0, assists: 0, cleanSheets: 0, defence: 0, motmVotes: 0, defensiveImpactVotes: 0, impact: 0 },
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

    // Build per-player aggregations
    const playerMap: Record<string, { goals: number; assists: number; cleanSheets: number; defence: number; impact: number; motmVotes: number; defensiveImpactVotes: number; matches: number }> = {};

    for (const stat of allStats) {
      const uid = String(stat.user_id);
      if (!playerMap[uid]) {
        playerMap[uid] = { goals: 0, assists: 0, cleanSheets: 0, defence: 0, impact: 0, motmVotes: 0, defensiveImpactVotes: 0, matches: 0 };
      }
      playerMap[uid].goals += Number(stat.goals) || 0;
      playerMap[uid].assists += Number(stat.assists) || 0;
      playerMap[uid].cleanSheets += Number(stat.cleanSheets) || 0;
      playerMap[uid].defence += Number(stat.defence) || 0;
      playerMap[uid].impact += Number(stat.impact) || 0;
      playerMap[uid].matches += 1;
    }

    // Add MOTM votes
    for (const vote of motmVotes) {
      const uid = String(vote.votedForId);
      if (playerMap[uid]) {
        playerMap[uid].motmVotes += 1;
      }
    }

    // Add defensive impact votes
    for (const [uid, count] of Object.entries(defImpactVoteMap)) {
      if (playerMap[uid]) {
        playerMap[uid].defensiveImpactVotes += count;
      }
    }

    // Calculate league-wide averages (per match per player)
    const playerIds = Object.keys(playerMap);
    const totalPlayers = playerIds.length;

    let totalGoalsAvg = 0, totalAssistsAvg = 0, totalCSAvg = 0, totalDefAvg = 0, totalMotmAvg = 0, totalDefImpactAvg = 0, totalImpactAvg = 0;

    const playersResult: Record<string, any> = {};
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
      totalGoalsAvg += avg.goals;
      totalAssistsAvg += avg.assists;
      totalCSAvg += avg.cleanSheets;
      totalDefAvg += avg.defence;
      totalMotmAvg += avg.motmVotes;
      totalDefImpactAvg += avg.defensiveImpactVotes;
      totalImpactAvg += avg.impact;
    }

    const divider = Math.max(totalPlayers, 1);
    const leagueAvg = {
      goals: +(totalGoalsAvg / divider).toFixed(2),
      assists: +(totalAssistsAvg / divider).toFixed(2),
      cleanSheets: +(totalCSAvg / divider).toFixed(2),
      defence: +(totalDefAvg / divider).toFixed(2),
      motmVotes: +(totalMotmAvg / divider).toFixed(2),
      defensiveImpactVotes: +(totalDefImpactAvg / divider).toFixed(2),
      impact: +(totalImpactAvg / divider).toFixed(2)
    };

    ctx.body = {
      success: true,
      totalMatches: matchIds.length,
      totalPlayers,
      leagueAvg,
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


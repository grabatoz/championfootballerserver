import { Context } from 'koa';
import models from '../models';
import { Op, fn, col, where, QueryTypes } from 'sequelize';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { uploadToCloudinary } from '../middleware/upload';
import { getInviteCode } from '../modules/utils';
import Season from '../models/Season';
import Notification from '../models/Notification';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { MatchAvailability } from '../models/MatchAvailability';

const { League, Match, User, MatchGuest } = models;

// Helper functions
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const normalizeTeam = (v: unknown): 'home' | 'away' =>
  String(v || '').toLowerCase() === 'away' ? 'away' : 'home';

type ApiMatchStatus = 'RESULT_PUBLISHED' | 'SCHEDULED' | 'ONGOING';

const normalizeStatus = (s?: string): ApiMatchStatus => {
  const v = String(s ?? '').toLowerCase();
  if (['result_published', 'result_uploaded', 'uploaded', 'complete', 'finished', 'ended', 'done'].includes(v)) return 'RESULT_PUBLISHED';
  if (['ongoing', 'inprogress', 'in_progress', 'live', 'playing'].includes(v)) return 'ONGOING';
  return 'SCHEDULED';
};

const toUserBasic = (p: any) => ({
  id: String(p?.id ?? ''),
  firstName: p?.firstName ?? '',
  lastName: p?.lastName ?? '',
  position: p?.positionType ?? p?.position ?? undefined,
  xp: typeof p?.xp === 'number' ? p.xp : (p?.xp ? Number(p.xp) : undefined),
});

// Get all leagues for current user
export const getAllLeagues = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }
  const userId = String(ctx.state.user.userId);
  try {
    const memberLeagues = await League.findAll({
      where: { '$members.id$': userId },
      include: [{ model: User, as: 'members', attributes: ['id'] }],
    });

    const adminLeagues = await League.findAll({
      where: { '$administeredLeagues.id$': userId },
      include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }],
    });

    const map: Record<string, any> = {};
    [...memberLeagues, ...adminLeagues].forEach((l: any) => { map[String(l.id)] = l; });
    const leagues = Object.values(map).map((l: any) => ({
      id: String(l.id),
      name: l.name,
      active: Boolean(l.active),
      image: (l as any).image ?? null,
    }));

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

  type PlayerStats = { played: number; wins: number; draws: number; losses: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number };

  const countCompleted = (league: any) =>
    (league.matches || []).filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED').length;

  const calcStats = (league: any): Record<string, PlayerStats> => {
    const stats: Record<string, PlayerStats> = {};
    const ensure = (pid: string) => {
      if (!stats[pid]) {
        stats[pid] = { played: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
      }
    };

    (league.members || []).forEach((p: any) => ensure(String(p.id)));
    (league.matches || []).forEach((m: any) => {
      (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
      (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
    });

    (league.matches || [])
      .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
      .forEach((m: any) => {
        const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
        const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));

        [...home, ...away].forEach((pid: string) => {
          if (!stats[pid]) return;
          stats[pid].played++;
        });

        const homeWon = (m.homeTeamGoals ?? 0) > (m.awayTeamGoals ?? 0);
        const awayWon = (m.awayTeamGoals ?? 0) > (m.homeTeamGoals ?? 0);

        home.forEach(pid => {
          if (!stats[pid]) return;
          if (homeWon) stats[pid].wins++;
          else if (awayWon) stats[pid].losses++;
          else stats[pid].draws++;
          stats[pid].teamGoalsConceded += m.awayTeamGoals ?? 0;
        });

        away.forEach(pid => {
          if (!stats[pid]) return;
          if (awayWon) stats[pid].wins++;
          else if (homeWon) stats[pid].losses++;
          else stats[pid].draws++;
          stats[pid].teamGoalsConceded += m.homeTeamGoals ?? 0;
        });
      });

    return stats;
  };

  try {
    const memberOf = await User.findByPk(userId, {
      include: [{
        model: League,
        as: 'leagues',
        include: [
          { model: User, as: 'members' },
          {
            model: Match,
            as: 'matches',
            include: [
              { model: User, as: 'homeTeamUsers' },
              { model: User, as: 'awayTeamUsers' }
            ]
          }
        ]
      }]
    });

    if (!memberOf) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'User not found' };
      return;
    }

    const all = (memberOf as any).leagues || [];
    const leagues = leagueIdQ ? all.filter((l: any) => String(l.id) === leagueIdQ) : all;

    const response = leagues.map((league: any) => {
      const stats = calcStats(league);
      const playerIds = Object.keys(stats);

      const sortByPoints = (a: string, b: string) => {
        const aPts = stats[a].wins * 3 + stats[a].draws;
        const bPts = stats[b].wins * 3 + stats[b].draws;
        return bPts - aPts;
      };

      const sortByGoals = (a: string, b: string) => stats[b].goals - stats[a].goals;
      const sortByAssists = (a: string, b: string) => stats[b].assists - stats[a].assists;
      const sortByMotm = (a: string, b: string) => stats[b].motmVotes - stats[a].motmVotes;
      const sortByWinPct = (a: string, b: string) => {
        const aPct = stats[a].played > 0 ? stats[a].wins / stats[a].played : 0;
        const bPct = stats[b].played > 0 ? stats[b].wins / stats[b].played : 0;
        if (Math.abs(bPct - aPct) < 0.001) return stats[b].motmVotes - stats[a].motmVotes;
        return bPct - aPct;
      };

      const sortByDefense = (defenderIds: string[]) => (a: string, b: string) => {
        const aConceded = stats[a].played > 0 ? stats[a].teamGoalsConceded / stats[a].played : Infinity;
        const bConceded = stats[b].played > 0 ? stats[b].teamGoalsConceded / stats[b].played : Infinity;
        return aConceded - bConceded;
      };

      const leagueTable = [...playerIds].sort(sortByPoints);
      const defenderIds = (league.members || []).filter((p: any) =>
        String(p.position || '').toLowerCase().includes('def') ||
        String(p.position || '').toLowerCase().includes('goal')
      ).map((p: any) => String(p.id));

      const winnerObj = (arr: string[], reason: string, label: string) => ({
        winnerId: arr[0] || null,
        reason,
        label,
        userId
      });

      const completedCount = countCompleted(league);
      const isTBC = completedCount === 0;
      const isPending = completedCount > 0 && completedCount < (league.maxGames ?? 0);

      const trophies: any[] = [];

      if (isTBC || isPending) {
        trophies.push({
          winnerId: null,
          reason: isTBC ? 'No completed matches yet' : `Only ${completedCount}/${league.maxGames} matches completed`,
          label: isTBC ? 'TBC' : 'In Progress',
          userId
        });
      } else {
        if (leagueTable[0]) trophies.push(winnerObj([leagueTable[0]], 'Most points', "Champion Footballer"));
        if (leagueTable[1]) trophies.push(winnerObj([leagueTable[1]], '2nd place', "Runner Up"));

        const sortedByMotm = [...playerIds].sort(sortByMotm);
        if (sortedByMotm[0]) trophies.push(winnerObj([sortedByMotm[0]], 'Most MOTM votes', "Ballon d'Or"));

        const sortedByGoals = [...playerIds].sort(sortByGoals);
        if (sortedByGoals[0]) trophies.push(winnerObj([sortedByGoals[0]], 'Most goals', "Golden Boot"));

        const sortedByAssists = [...playerIds].sort(sortByAssists);
        if (sortedByAssists[0]) trophies.push(winnerObj([sortedByAssists[0]], 'Most assists', "King Playmaker"));

        const sortedByWinPct = [...playerIds].sort(sortByWinPct);
        if (sortedByWinPct[0]) trophies.push(winnerObj([sortedByWinPct[0]], 'Highest win %', "GOAT"));

        if (defenderIds.length > 0) {
          const sortedDef = [...defenderIds].sort(sortByDefense(defenderIds));
          if (sortedDef[0]) trophies.push(winnerObj([sortedDef[0]], 'Best defense', "Legendary Shield"));
        }

        const bottom = leagueTable.slice(3);
        if (bottom.length > 0) {
          const darkHorse = [...bottom].sort(sortByMotm)[0];
          if (darkHorse) trophies.push(winnerObj([darkHorse], 'Most MOTM from bottom half', "The Dark Horse"));
        }
      }

      return {
        leagueId: String(league.id),
        leagueName: league.name,
        completedMatches: completedCount,
        maxGames: league.maxGames ?? 0,
        trophies
      };
    });

    ctx.body = { success: true, data: response };
  } catch (err) {
    console.error('Trophy room error', err);
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
    const leagues = await League.findAll({
      where: {
        [Op.or]: [
          { '$members.id$': userId },
          { '$administeredLeagues.id$': userId }
        ]
      },
      include: [
        { model: User, as: 'members', attributes: ['id'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] }
      ]
    });

    const result = {
      success: true,
      leagues: leagues.map(l => ({
        id: l.id,
        name: l.name,
        active: l.active,
        image: (l as any).image
      }))
    };

    cache.set(cacheKey, result, 600);
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
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] },
        {
          model: Season,
          as: 'seasons',
          attributes: ['id', 'seasonNumber', 'name', 'isActive', 'startDate', 'endDate', 'createdAt'],
          include: [
            {
              model: User,
              as: 'players',
              attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType', 'xp', 'shirtNumber'],
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
          { model: Vote, as: 'votes', attributes: ['voterId', 'votedForId'] }
        ],
        order: [['createdAt', 'ASC']] // Order by creation date to assign matchNumber
      });

      console.log(`📊 [ADMIN] Fetching ALL matches for league ${id}: ${matches.length} matches`);
      matches.forEach((m: any) => {
        console.log(`   - ${m.homeTeamName} vs ${m.awayTeamName} | seasonId: ${m.seasonId}`);
      });

      // Add matchNumber and process votes for each match
      const matchesWithNumbers = matches.map((match: any, index: number) => {
        const matchJson = match.toJSON();
        
        // Convert votes array to manOfTheMatchVotes object format
        const manOfTheMatchVotes: Record<string, string> = {};
        if (matchJson.votes && Array.isArray(matchJson.votes)) {
          matchJson.votes.forEach((vote: any) => {
            manOfTheMatchVotes[vote.voterId] = vote.votedForId;
          });
        }
        delete matchJson.votes; // Remove votes array
        
        return {
          ...matchJson,
          matchNumber: index + 1,
          manOfTheMatchVotes
        };
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

      ctx.body = {
        success: true,
        league: {
          id: league.id,
          name: league.name,
          inviteCode: league.inviteCode,
          active: league.active,
          image: (league as any).image,
          maxGames: league.maxGames,
          members: (league as any).members || [],
          matches: matchesWithNumbers,
          seasons: formattedSeasons, // Admin sees ALL seasons with members
          currentSeason: activeSeason || (seasons.length > 0 ? seasons[0] : null), // Admin's current = active season
          administrators: (league as any).administeredLeagues || [],
          isAdmin
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
        { model: Vote, as: 'votes', attributes: ['voterId', 'votedForId'] }
      ],
      order: [['createdAt', 'ASC']] // Order by creation date to assign matchNumber
    });
    
    console.log(`📊 [MEMBER] Fetching matches for user's seasons: ${matches.length} matches`);
    matches.forEach((m: any) => {
      console.log(`   - ${m.homeTeamName} vs ${m.awayTeamName} | seasonId: ${m.seasonId}`);
    });

    // Add matchNumber and process votes for each match
    const matchesWithNumbers = matches.map((match: any, index: number) => {
      const matchJson = match.toJSON();
      
      // Convert votes array to manOfTheMatchVotes object format
      const manOfTheMatchVotes: Record<string, string> = {};
      if (matchJson.votes && Array.isArray(matchJson.votes)) {
        matchJson.votes.forEach((vote: any) => {
          manOfTheMatchVotes[vote.voterId] = vote.votedForId;
        });
      }
      delete matchJson.votes; // Remove votes array
      
      return {
        ...matchJson,
        matchNumber: index + 1,
        manOfTheMatchVotes
      };
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

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        inviteCode: league.inviteCode,
        active: league.active,
        image: (league as any).image,
        maxGames: league.maxGames,
        members: (league as any).members || [],
        matches: matchesWithNumbers,
        seasons: filteredSeasons, // Only show seasons user is member of
        currentSeason: userCurrentSeason, // User's current season
        administrators: (league as any).administeredLeagues || [],
        isAdmin
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

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    // Find the league with members
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

    // Build XP map from MatchStatistics
    const xpMap: Record<string, number> = {};
    const avgMap: Record<string, number> = {};
    const matchCountMap: Record<string, number> = {};

    if (seasonId) {
      try {
        // Get all match statistics for this league's active season
        const stats = await MatchStatistics.findAll({
          include: [
            {
              model: Match,
              as: 'match',
              where: {
                leagueId: id,
                seasonId: seasonId,
                status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
              },
              attributes: ['id'],
              required: true
            }
          ],
          attributes: [['user_id', 'userId'], ['xp_awarded', 'xpAwarded']]
        });

        // Aggregate XP by user
        for (const stat of stats) {
          const statUserId = String((stat as any).userId);
          const xp = (stat as any).xpAwarded || 0;
          if (!xpMap[statUserId]) {
            xpMap[statUserId] = 0;
            matchCountMap[statUserId] = 0;
          }
          xpMap[statUserId] += xp;
          matchCountMap[statUserId] += 1;
        }

        // Calculate averages
        for (const [uid, totalXP] of Object.entries(xpMap)) {
          const matchCount = matchCountMap[uid] || 1;
          avgMap[uid] = Math.round(totalXP / matchCount);
        }
      } catch (statsErr) {
        console.log('Could not fetch XP stats:', statsErr);
        // Non-critical, return empty maps
      }
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

  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  try {
    // Count MOTM votes for this player in this league
    const motmCount = await (Vote as any).count({
      include: [
        {
          model: Match,
          as: 'votedMatch',
          where: { leagueId },
          attributes: [],
          required: true
        }
      ],
      where: {
        votedForId: playerId
      }
    });

    ctx.body = {
      success: true,
      motmCount: motmCount || 0
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

    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update status');
      return;
    }

    await league.update({ active: Boolean(active) });

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        active: league.active
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
  const { name, maxGames } = ctx.request.body as any;

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
      ctx.throw(403, 'Only league admins can update');
      return;
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (maxGames) updateData.maxGames = Number(maxGames);

    await league.update(updateData);

    ctx.body = {
      success: true,
      league: {
        id: league.id,
        name: league.name,
        maxGames: league.maxGames
      }
    };
  } catch (err) {
    console.error('Update league error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update league' };
  }
};

// Delete league
export const deleteLeague = async (ctx: Context) => {
  const { id } = ctx.params;

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
      ctx.throw(403, 'Only league admins can delete');
      return;
    }

    await league.destroy();

    cache.clearPattern(`user_leagues_`);

    ctx.body = {
      success: true,
      message: 'League deleted successfully'
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
    ctx.throw(400, 'Invite code is required');
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
      ctx.throw(404, 'League not found with this invite code');
      return;
    }

    const isMember = (league as any).members?.some((m: any) => String(m.id) === String(userId));
    if (isMember) {
      ctx.throw(400, 'Already a member of this league');
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
        { model: User, as: 'members', attributes: ['id'] },
        { model: User, as: 'administeredLeagues', attributes: ['id'] }
      ]
    });

    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    const isAdmin = (league as any).administeredLeagues?.some((a: any) => String(a.id) === String(userId));
    if (isAdmin) {
      ctx.throw(400, 'League admins cannot leave. Delete the league or transfer ownership first.');
      return;
    }

    const user = await User.findByPk(userId);
    if (user) {
      await (league as any).removeMember(user);
    }

    cache.clearPattern(`user_leagues_${userId}`);

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

    cache.clearPattern(`user_leagues_`);

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

    console.log(`📅 Creating match for league ${leagueId} in active Season ${activeSeason.seasonNumber} (${activeSeason.id})`);

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
    if (homeTeamUsers) {
      try {
        const homeIds = JSON.parse(homeTeamUsers);
        if (Array.isArray(homeIds) && homeIds.length > 0) {
          await (match as any).setHomeTeamUsers(homeIds);
        }
      } catch (e) {
        console.warn('Failed to parse homeTeamUsers', e);
      }
    }

    if (awayTeamUsers) {
      try {
        const awayIds = JSON.parse(awayTeamUsers);
        if (Array.isArray(awayIds) && awayIds.length > 0) {
          await (match as any).setAwayTeamUsers(awayIds);
        }
      } catch (e) {
        console.warn('Failed to parse awayTeamUsers', e);
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

      // Get match number (count of matches in this season + 1)
      const matchCount = await Match.count({
        where: { leagueId, seasonId: activeSeason.id }
      });

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
    notifyOnly
  } = body;

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
    if (notes !== undefined) updateData.notes = notes;
    if (homeTeamImage) updateData.homeTeamImage = homeTeamImage;
    if (awayTeamImage) updateData.awayTeamImage = awayTeamImage;
    if (homeCaptainId !== undefined) updateData.homeCaptainId = homeCaptainId || null;
    if (awayCaptainId !== undefined) updateData.awayCaptainId = awayCaptainId || null;

    await match.update(updateData);

    // Parse team user arrays
    const homeIds: string[] = homeTeamUsers ? JSON.parse(homeTeamUsers) : [];
    const awayIds: string[] = awayTeamUsers ? JSON.parse(awayTeamUsers) : [];

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

    // Handle guests
    const homeGuestsData = homeGuests ? JSON.parse(homeGuests) : [];
    const awayGuestsData = awayGuests ? JSON.parse(awayGuests) : [];

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
      message: 'Match updated successfully'
    };
  } catch (err) {
    console.error('Update match in league error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update match' };
  }
};

// Export all functions
export {
  // Match creation in league context is handled in matchController
  // but route delegation might still be here
};
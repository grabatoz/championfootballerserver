import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import { League } from '../types/user';
import cache from '../utils/cache';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

const router = new Router({ prefix: '/players' });

// Add a GET /players endpoint with ULTRA FAST caching
router.get('/', async (ctx) => {
  const cacheKey = 'players_all_ultra_fast';
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }
  
  try {
    const players = await UserModel.findAll({
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType'],
      where: {
        xp: { [Op.gt]: 0 } // Only players with XP for speed
      },
      order: [['xp', 'DESC']],
      limit: 50 // Reduced limit for ultra speed
    });
    
    const result = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        profilePicture: p.profilePicture,
        rating: p.xp || 0,
        position: p.position,
        positionType: p.positionType,
      })),
    };
    cache.set(cacheKey, result, 1800); // 30 min cache for ULTRA speed
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error('Error fetching all players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
});

// Get all players the current user has played with or against
router.get('/played-with', required, async (ctx) => {
  try {
    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }
    const userId = ctx.state.user.userId;

    // Find all match IDs the user has played in, based on stats
    const userMatchStats = await MatchStatistics.findAll({
      where: { user_id: userId },
      attributes: ['match_id']
    });

    const matchIds = userMatchStats.map(stat => stat.match_id);

    if (matchIds.length === 0) {
      ctx.body = { success: true, players: [] };
      return;
    }

    // Find all player IDs who participated in those matches
    const allPlayerStats = await MatchStatistics.findAll({
      where: {
        match_id: {
          [Op.in]: matchIds
        }
      },
      attributes: ['user_id']
    });

    const playerIds = new Set<string>(allPlayerStats.map(stat => stat.user_id));
    
    // Remove the current user from the set
    playerIds.delete(userId);

    // Fetch details for all unique players
    const players = await UserModel.findAll({
      where: {
        id: {
          [Op.in]: Array.from(playerIds)
        }
      },
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp','shirtNumber']
    });

    ctx.body = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        profilePicture: p.profilePicture,
        rating: p.xp || 0 // Assuming XP is the rating
        ,shirtNumber: p.shirtNumber
      }))
    };

  } catch (error) {
    console.error('Error fetching played-with players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
});

// GET player career stats
router.get('/:id/stats', required, async (ctx) => {
    const { id: playerId } = ctx.params;
    const { leagueId, year } = ctx.query as { leagueId?: string, year?: string };
    const cacheKey = `player_stats_${playerId}_${leagueId || 'all'}_${year || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }
    try {
        const player = await UserModel.findByPk(playerId, {
            attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'age', 'style', 'positionType', 'preferredFoot', 'shirtNumber']
        });

        if (!player) {
            ctx.throw(404, 'Player not found');
            return;
        }
        
        // Find ALL leagues where the player has EVER been a member (historical join)
        // Use Sequelize association instead of LeagueMember join table
        const playerWithLeagues = await UserModel.findByPk(playerId, {
            include: [
                {
                    model: LeagueModel,
                    as: 'leagues', // Make sure this matches your association alias
                    include: [
                        {
                            model: UserModel,
                            as: 'members',
                            attributes: ['id', 'firstName', 'lastName', 'position', 'positionType']
                        },
                        {
                            model: MatchModel,
                            as: 'matches',
                            required: false,
                            include: [
                                { model: UserModel, as: 'homeTeamUsers' },
                                { model: UserModel, as: 'awayTeamUsers' }
                            ]
                        }
                    ]
                }
            ]
        });
        const allLeagues = (playerWithLeagues as any)?.leagues || [];
        const playerLeagues = allLeagues;

        // --- Filter matches by year and player participation for stats, but not for league list ---
        const selectedYear = year && year !== 'all' ? Number(year) : null;
        const filteredLeagues = selectedYear
          ? playerLeagues.filter((league: any) =>
              (league.matches || []).some((match: any) =>
                new Date(match.date).getFullYear() === selectedYear &&
                (
                  (match.homeTeamUsers && match.homeTeamUsers.some((u: any) => String(u.id) === String(playerId))) ||
                  (match.awayTeamUsers && match.awayTeamUsers.some((u: any) => String(u.id) === String(playerId)))
                )
              )
            )
          : playerLeagues;

        // Filter matches: only those in the selected year where player played
        const allMatches = filteredLeagues.flatMap((l: any) =>
          (l.matches || []).filter((match: any) =>
            (!selectedYear || new Date(match.date).getFullYear() === selectedYear) &&
            (
              (match.homeTeamUsers && match.homeTeamUsers.some((u: any) => String(u.id) === String(playerId))) ||
              (match.awayTeamUsers && match.awayTeamUsers.some((u: any) => String(u.id) === String(playerId)))
            )
          )
        );

        // const allMatchIds = allMatches.map((m: any) => m.id);

        const getYearsFromMatches = (matches: any[]) => {
            return [...new Set(matches.map(m => new Date(m.date).getFullYear()))].sort((a, b) => b - a);
        };

        const buildStats = async (matchesToStat: any[]) => {
            const matchIds = matchesToStat.map(m => m.id);
            if (matchIds.length === 0) return { Goals: 0, Assist: 0, 'Clean Sheet': 0, 'MOTM Votes': 0, 'Best Win': 0, 'Total Wins': 0, 'xWin %': 0 };

            const statsResult = await MatchStatistics.findOne({
                where: { user_id: playerId, match_id: { [Op.in]: matchIds } },
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('goals')), 'goals'],
                    [sequelize.fn('SUM', sequelize.col('assists')), 'assists'],
                    [sequelize.fn('SUM', sequelize.col('clean_sheets')), 'cleanSheets'],
                ]
            });

            const votes = await Vote.count({ where: { votedForId: playerId, matchId: { [Op.in]: matchIds } } });
            const goals = statsResult?.get('goals') || 0;
            const assists = statsResult?.get('assists') || 0;
            const cleanSheets = statsResult?.get('cleanSheets') || 0;

            let totalWins = 0;
            let bestWinMargin = 0;
            let totalMatchesPlayed = 0;

            for (const match of matchesToStat) {
                const isHomePlayer = match.homeTeamUsers?.some((p: any) => p.id === playerId);
                const isAwayPlayer = match.awayTeamUsers?.some((p: any) => p.id === playerId);
                
                if (isHomePlayer || isAwayPlayer) {
                    totalMatchesPlayed++;
                    const homeWon = match.homeTeamGoals > match.awayTeamGoals;
                    const awayWon = match.awayTeamGoals > match.homeTeamGoals;

                    if ((isHomePlayer && homeWon) || (isAwayPlayer && awayWon)) {
                        totalWins++;
                        const margin = Math.abs(match.homeTeamGoals - match.awayTeamGoals);
                        if (margin > bestWinMargin) {
                            bestWinMargin = margin;
                        }
                    }
                }
            }
            
            const xWinPercentage = totalMatchesPlayed > 0 ? Math.round((totalWins / totalMatchesPlayed) * 100) : 0;

            return {
                Goals: Number(goals), Assist: Number(assists), 'Clean Sheet': Number(cleanSheets),
                'MOTM Votes': votes, 'Best Win': bestWinMargin, 'Total Wins': totalWins, 'xWin %': xWinPercentage,
            };
        };

        // --- Calculate Accumulative Stats & Trophies ---
        const accumulativeStats = await buildStats(allMatches);
        
        // --- Calculate Accumulative Trophies ---
        const trophyMap: Record<string, { leagueId: string, leagueName: string }[]> = {
          'Champion Footballer': [],
          'Runner Up': [],
          "Ballon d'Or": [],
          'GOAT': [],
          'Golden Boot': [],
          'King Playmaker': [],
          'Legendary Shield': [],
          'The Dark Horse': []
        };

        for (const league of filteredLeagues) {
            // if ((league.matches || []).length < league.maxGames) continue; // Skip incomplete leagues

            const leaguePlayerIds = ((league as any).members || []).map((m: any) => m.id);
            if(leaguePlayerIds.length === 0) continue;

            const playerStats: Record<string, { wins: number; losses: number; draws: number; played: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number; }> = {};

            leaguePlayerIds.forEach((id: string) => {
                playerStats[id] = { wins: 0, losses: 0, draws: 0, played: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
            });

            (league.matches || []).forEach((match: any) => {
                const homeWon = match.homeTeamGoals > match.awayTeamGoals;
                const awayWon = match.awayTeamGoals > match.homeTeamGoals;

                match.homeTeamUsers?.forEach((p: any) => {
                    if (!playerStats[p.id]) return;
                    playerStats[p.id].played++;
                    if (homeWon) playerStats[p.id].wins++; else if (awayWon) playerStats[p.id].losses++; else playerStats[p.id].draws++;
                    playerStats[p.id].teamGoalsConceded += match.awayTeamGoals || 0;
                });
                match.awayTeamUsers?.forEach((p: any) => {
                    if (!playerStats[p.id]) return;
                    playerStats[p.id].played++;
                    if (awayWon) playerStats[p.id].wins++; else if (homeWon) playerStats[p.id].losses++; else playerStats[p.id].draws++;
                    playerStats[p.id].teamGoalsConceded += match.homeTeamGoals || 0;
                });
            });

            const leagueMatchIds = (league.matches || []).map((m: any) => m.id);
            if (leagueMatchIds.length > 0) {
                const statsResults = await MatchStatistics.findAll({
                    where: { match_id: { [Op.in]: leagueMatchIds } },
                    attributes: ['user_id', [sequelize.fn('SUM', sequelize.col('goals')), 'total_goals'], [sequelize.fn('SUM', sequelize.col('assists')), 'total_assists']],
                    group: ['user_id']
                });
                statsResults.forEach((stat: any) => {
                    if (playerStats[stat.get('user_id')]) {
                        playerStats[stat.get('user_id')].goals = Number(stat.get('total_goals') || 0);
                        playerStats[stat.get('user_id')].assists = Number(stat.get('total_assists') || 0);
                    }
                });

                const voteResults = await Vote.findAll({
                    where: { matchId: { [Op.in]: leagueMatchIds } },
                    attributes: ['votedForId', [sequelize.fn('COUNT', sequelize.col('votedForId')), 'voteCount']],
                    group: ['votedForId']
                });
                voteResults.forEach((vote: any) => {
                    if (playerStats[vote.get('votedForId')]) {
                        playerStats[vote.get('votedForId')].motmVotes = Number(vote.get('voteCount') || 0);
                    }
                });
            }

            const sortedLeagueTable = [...leaguePlayerIds].sort((a, b) => (playerStats[b].wins * 3 + playerStats[b].draws) - (playerStats[a].wins * 3 + playerStats[a].draws));
            if (sortedLeagueTable[0] === playerId) trophyMap['Champion Footballer'].push({ leagueId: league.id, leagueName: league.name });
            if (sortedLeagueTable[1] === playerId) trophyMap['Runner Up'].push({ leagueId: league.id, leagueName: league.name });
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) trophyMap["Ballon d'Or"].push({ leagueId: league.id, leagueName: league.name });
            if ([...leaguePlayerIds].sort((a, b) => ((playerStats[b].wins / playerStats[b].played) || 0) - ((playerStats[a].wins / playerStats[a].played) || 0) || playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) trophyMap['GOAT'].push({ leagueId: league.id, leagueName: league.name });
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].goals - playerStats[a].goals)[0] === playerId) trophyMap['Golden Boot'].push({ leagueId: league.id, leagueName: league.name });
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].assists - playerStats[a].assists)[0] === playerId) trophyMap['King Playmaker'].push({ leagueId: league.id, leagueName: league.name });

            const defensivePlayerIds = ((league as any).members || []).filter((p: any) => p.position === 'Defender' || p.position === 'Goalkeeper').map((p: any) => p.id);
            if (defensivePlayerIds.length > 0 && defensivePlayerIds.sort((a: string, b: string) => ((playerStats[a].teamGoalsConceded / playerStats[a].played) || Infinity) - ((playerStats[b].teamGoalsConceded / playerStats[b].played) || Infinity))[0] === playerId) {
                trophyMap['Legendary Shield'].push({ leagueId: league.id, leagueName: league.name });
            }

            if (sortedLeagueTable.length > 3 && sortedLeagueTable.slice(3).sort((a, b) => playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) {
                trophyMap['The Dark Horse'].push({ leagueId: league.id, leagueName: league.name });
            }
        }

        // --- Calculate Current (Filtered) Stats ---
        let filteredMatches = allMatches;
        if (leagueId && leagueId !== 'all') {
            filteredMatches = filteredMatches.filter((m: { leagueId: any }) => m.leagueId.toString() === leagueId);
        }
        if (year && year !== 'all') {
            filteredMatches = filteredMatches.filter((m: { date: string }) => new Date(m.date).getFullYear() === Number(year));
        }
        const currentStats = await buildStats(filteredMatches);
        
        // Build leagues array with matches for this player in this year
        const playerLeaguesWithMatches = await Promise.all(playerLeagues.map(async (league: any) => {
          // For each league, filter matches by year if requested
          let filteredMatches = league.matches || [];
          if (selectedYear) {
            filteredMatches = filteredMatches.filter((match: any) => new Date(match.date).getFullYear() === selectedYear);
          }
          // Get player stats for each match
          const matchesWithStats = await Promise.all(filteredMatches.map(async (match: any) => {
            const playerStats = await MatchStatistics.findOne({
              where: { 
                user_id: playerId, 
                match_id: match.id 
              },
              attributes: ['goals', 'assists', 'clean_sheets']
            });
            const motmVotes = await Vote.count({
              where: { 
                votedForId: playerId, 
                matchId: match.id 
              }
            });
            return {
              ...match.toJSON(),
              playerStats: playerStats ? {
                goals: playerStats.goals || 0,
                assists: playerStats.assists || 0,
                cleanSheets: playerStats.cleanSheets || 0,
                motmVotes: motmVotes
              } : null
            };
          }));
          return {
            id: league.id,
            name: league.name,
            matches: matchesWithStats,
            members: (league as any).members || [],
          };
        }));

        const result = {
            success: true,
            data: {
                player: {
                    id: player.id,
                    name: `${player.firstName} ${player.lastName}`,
                    position: player.position || 'N/A',
                    rating: player.xp || 0,
                    avatar: player.profilePicture,
                    age: player.age || null,
                    style: player.style || null,
                    positionType: player.positionType || null,
                    preferredFoot: player.preferredFoot || null,
                    shirtNo: player.shirtNumber ? String(player.shirtNumber) : '-',
                },
                leagues: playerLeaguesWithMatches, // <-- always all leagues ever joined
                years: getYearsFromMatches(allMatches),
                currentStats,
                accumulativeStats,
                trophies: trophyMap // <-- now includes league info for each trophy
            }
        };
        cache.set(cacheKey, result, 600); // cache for 30 seconds
        ctx.body = result;
    } catch (error) {
        console.error('Error fetching player stats:', error);
        ctx.throw(500, 'Failed to fetch player stats.');
    }
});

// GET /api/player/:playerId/leagues-matches?year=2025
router.get('/:playerId/leagues-matches', async (ctx) => {
  try {
    const { playerId } = ctx.params;
    const { year } = ctx.query;

    if (!year) {
      ctx.status = 400;
      ctx.body = { error: 'Year is required' };
      return;
    }

    const leagues = await LeagueModel.findAll({ include: [{ model: MatchModel, as: 'matches' }] });

    const filteredLeagues = leagues
      .map((league: any) => {
        const matches = (league.matches || []).filter((match: any) =>
          new Date(match.date).getFullYear() === Number(year) &&
          (
            (match.homeTeamUsers && match.homeTeamUsers.some((u: any) => String(u.id) === String(playerId))) ||
            (match.awayTeamUsers && match.awayTeamUsers.some((u: any) => String(u.id) === String(playerId)))
          )
        );
        return matches.length > 0 ? { ...league.toJSON(), matches } : null;
      })
      .filter(Boolean);

    ctx.body = filteredLeagues;
  } catch (err) {
    console.error(err);
    ctx.status = 500;
    ctx.body = { error: 'Server error' };
  }
});

// League-wise teammates (players a given player has played with inside a league)
router.get('/:playerId/leagues/:leagueId/teammates', required, async (ctx) => {
  try {
    const { playerId, leagueId } = ctx.params;

    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }

    // Basic validation
    if (!playerId || !leagueId) {
      ctx.throw(400, 'playerId and leagueId are required');
      return;
    }

    // Optional: check player exists
    const player = await UserModel.findByPk(playerId, { attributes: ['id'] });
    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    // Optional: confirm league exists
    const league = await LeagueModel.findByPk(leagueId, { attributes: ['id'] });
    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    // Cache key
    const cacheKey = `league_teammates_${playerId}_${leagueId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }

    // 1. Get all matches in this league
    const leagueMatches = await MatchModel.findAll({
      where: { leagueId },
      attributes: ['id']
    });
    const leagueMatchIds = leagueMatches.map(m => m.id);

    if (leagueMatchIds.length === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    // 2. Get matches (in this league) that the player participated in (via stats)
    const playerLeagueStats = await MatchStatistics.findAll({
      where: {
        user_id: playerId,
        match_id: { [Op.in]: leagueMatchIds }
      },
      attributes: ['match_id']
    });
    const participatedMatchIds = playerLeagueStats.map(s => s.match_id);

    if (participatedMatchIds.length === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    // 3. Get ALL stats rows for those matches to gather co-player ids
    const allStatsSameMatches = await MatchStatistics.findAll({
      where: {
        match_id: { [Op.in]: participatedMatchIds }
      },
      attributes: ['user_id']
    });

    const teammateIdsSet = new Set<string>(allStatsSameMatches.map(s => s.user_id));
    teammateIdsSet.delete(String(playerId));

    if (teammateIdsSet.size === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    const teammateIds = Array.from(teammateIdsSet);

    // 4. Fetch teammate user records
    const teammates = await UserModel.findAll({
      where: {
        id: { [Op.in]: teammateIds }
      },
      attributes: [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'xp',
        'position',
        'positionType',
        'shirtNumber'
      ]
    });

    // (Optional) Aggregate simple per-player stats inside this league (goals, assists, matches)
    const leagueStatsAgg = await MatchStatistics.findAll({
      where: {
        user_id: { [Op.in]: teammateIds },
        match_id: { [Op.in]: participatedMatchIds }
      },
      attributes: [
        'user_id',
        [sequelize.fn('SUM', sequelize.col('goals')), 'goals'],
        [sequelize.fn('SUM', sequelize.col('assists')), 'assists'],
        [sequelize.fn('COUNT', sequelize.col('match_id')), 'appearances']
      ],
      group: ['user_id']
    });

    const statMap: Record<string, { goals: number; assists: number; appearances: number }> = {};
    leagueStatsAgg.forEach((row: any) => {
      statMap[row.get('user_id')] = {
        goals: Number(row.get('goals') || 0),
        assists: Number(row.get('assists') || 0),
        appearances: Number(row.get('appearances') || 0)
      };
    });

    const resultPlayers = teammates.map(t => {
      const stats = statMap[t.id] || { goals: 0, assists: 0, appearances: 0 };
      return {
        id: t.id,
        firstName: t.firstName,
        lastName: t.lastName,
        name: `${t.firstName} ${t.lastName}`.trim(),
        avatar: t.profilePicture,
        profilePicture: t.profilePicture,
        rating: t.xp || 0,
        position: t.position,
        positionType: t.positionType,
        shirtNumber: t.shirtNumber,
        goals: stats.goals,
        assists: stats.assists,
        appearances: stats.appearances
      };
    });

    const payload = { success: true, data: resultPlayers, players: resultPlayers, leagueId, playerId };
    cache.set(cacheKey, payload, 300); // 5 min
    ctx.body = payload;
  } catch (err) {
    console.error('Error fetching league teammates:', err);
    ctx.throw(500, 'Failed to fetch league teammates.');
  }
});

interface SimplePairingAgg {
  playerId: string;
  name: string;
  matchesTogether: number;
  winsTogether: number;
}
interface SimpleRivalAgg {
  playerId: string;
  name: string;
  matchesAgainst: number;
  lossesAgainst: number;
}

const inMemorySynergyCache = new Map<string, { data: any; ts: number }>();
const SYNERGY_TTL_MS = 60_000; // 1 min cache

/**
 * Logic:
 * For each player in the same league:
 *  - Best Pairing: teammate with whom the player accumulated the most wins (tie -> higher win rate -> more matches)
 *  - Toughest Rival: opponent versus whom the player accumulated the most losses (tie -> higher loss rate -> more matches)
 * Optional leagueId query returns only that league summary; otherwise returns all leagues.
 */
router.get('/:playerId/simple-synergy', async (ctx) => {
  const { playerId } = ctx.params;
  const { leagueId } = ctx.query as { leagueId?: string };

  if (!playerId) {
    ctx.status = 400;
    ctx.body = { error: 'playerId required' };
    return;
  }

  const cacheKey = `synergy:leagues:${playerId}:${leagueId || 'ALL'}`;
  const cached = inMemorySynergyCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SYNERGY_TTL_MS) {
    ctx.body = cached.data;
    return;
  }

  try {
    // 1. Get all match ids where this player has a stats row
    const playerStatRows = await MatchStatistics.findAll({
      where: { user_id: playerId },
      attributes: ['match_id']
    });
    const allMatchIds = playerStatRows.map(r => r.match_id);
    if (allMatchIds.length === 0) {
      const emptyPayload = leagueId
        ? {
            playerId,
            leagueId,
            participatedMatches: 0,
            bestPairing: null,
            toughestRival: null,
            generatedAt: new Date().toISOString()
          }
        : {
            playerId,
            leagues: [],
            generatedAt: new Date().toISOString()
          };
      inMemorySynergyCache.set(cacheKey, { data: emptyPayload, ts: Date.now() });
      ctx.body = emptyPayload;
      return;
    }

    // 2. Fetch matches (filtered by league if requested)
    const matchWhere: any = { id: { [Op.in]: allMatchIds } };
    if (leagueId) matchWhere.leagueId = leagueId;

    const matches = await MatchModel.findAll({
      where: matchWhere,
      include: [
        { model: models.User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName'] },
        { model: models.User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['date', 'ASC']]
    });

    if (!matches.length) {
      const emptyPayload = leagueId
        ? {
            playerId,
            leagueId,
            participatedMatches: 0,
            bestPairing: null,
            toughestRival: null,
            generatedAt: new Date().toISOString()
          }
        : {
            playerId,
            leagues: [],
            generatedAt: new Date().toISOString()
          };
      inMemorySynergyCache.set(cacheKey, { data: emptyPayload, ts: Date.now() });
      ctx.body = emptyPayload;
      return;
    }

    // Helper normalize
    const norm = (arr: any[]): { id: string; name: string }[] =>
      (Array.isArray(arr) ? arr : [])
        .map(u => ({
          id: String(u.id),
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim()
        }))
        .filter(p => p.id);

    interface PairingAgg {
      playerId: string;
      name: string;
      matchesTogether: number;
      winsTogether: number;
    }
    interface RivalAgg {
      playerId: string;
      name: string;
      matchesAgainst: number;
      lossesAgainst: number;
    }

    // Group matches by leagueId
    const leagueBuckets = new Map<string, { leagueId: string; leagueName?: string; matches: any[] }>();
    matches.forEach(m => {
      const lid = String(m.leagueId);
      if (!leagueBuckets.has(lid)) {
        leagueBuckets.set(lid, { leagueId: lid, leagueName: (m as any).leagueName || undefined, matches: [] });
      }
      leagueBuckets.get(lid)!.matches.push(m);
    });

    const buildLeagueSynergy = (bucket: { leagueId: string; leagueName?: string; matches: any[] }) => {
      const teammateMap = new Map<string, PairingAgg>();
      const rivalMap = new Map<string, RivalAgg>();
      let participated = 0;

      bucket.matches.forEach(m => {
        const home = norm((m as any).homeTeamUsers);
        const away = norm((m as any).awayTeamUsers);
        const pid = String(playerId);
        const onHome = home.some(p => p.id === pid);
        const onAway = away.some(p => p.id === pid);
        if (!onHome && !onAway) return;
        if (onHome && onAway) return; // corrupt data safety
        participated++;

        const myTeam = onHome ? home : away;
        const oppTeam = onHome ? away : home;

        const hGoals = (m as any).homeTeamGoals;
        const aGoals = (m as any).awayTeamGoals;
        let res: 'W' | 'L' | 'D' | null = null;
        if (hGoals != null && aGoals != null) {
          if (hGoals === aGoals) res = 'D';
          else {
            const iWon = onHome ? hGoals > aGoals : aGoals > hGoals;
            res = iWon ? 'W' : 'L';
          }
        }

        myTeam.filter(p => p.id !== pid).forEach(p => {
          if (!teammateMap.has(p.id)) {
            teammateMap.set(p.id, {
              playerId: p.id,
              name: p.name || p.id,
              matchesTogether: 0,
              winsTogether: 0
            });
          }
          const agg = teammateMap.get(p.id)!;
          agg.matchesTogether++;
          if (res === 'W') agg.winsTogether++;
        });

        oppTeam.forEach(p => {
          if (!rivalMap.has(p.id)) {
            rivalMap.set(p.id, {
              playerId: p.id,
              name: p.name || p.id,
              matchesAgainst: 0,
              lossesAgainst: 0
            });
          }
          const agg = rivalMap.get(p.id)!;
          agg.matchesAgainst++;
          if (res === 'L') agg.lossesAgainst++;
        });
      });

      const teammateArr = [...teammateMap.values()].filter(t => t.matchesTogether > 0);
      const rivalArr = [...rivalMap.values()].filter(r => r.matchesAgainst > 0);

      const bestPairing = teammateArr
        .sort((a, b) => {
          if (b.winsTogether !== a.winsTogether) return b.winsTogether - a.winsTogether;
          const wrA = a.matchesTogether ? a.winsTogether / a.matchesTogether : 0;
          const wrB = b.matchesTogether ? b.winsTogether / b.matchesTogether : 0;
          if (wrB !== wrA) return wrB - wrA;
          return b.matchesTogether - a.matchesTogether;
        })[0] || null;

      const toughestRival = rivalArr
        .sort((a, b) => {
          if (b.lossesAgainst !== a.lossesAgainst) return b.lossesAgainst - a.lossesAgainst;
          const lrA = a.matchesAgainst ? a.lossesAgainst / a.matchesAgainst : 0;
            const lrB = b.matchesAgainst ? b.lossesAgainst / b.matchesAgainst : 0;
          if (lrB !== lrA) return lrB - lrA;
          return b.matchesAgainst - a.matchesAgainst;
        })[0] || null;

      return {
        leagueId: bucket.leagueId,
        leagueName: bucket.leagueName || null,
        participatedMatches: participated,
        bestPairing: bestPairing && {
          ...bestPairing,
          winRate: +(bestPairing.winsTogether / Math.max(1, bestPairing.matchesTogether) * 100).toFixed(2)
        },
        toughestRival: toughestRival && {
          ...toughestRival,
          lossRate: +(toughestRival.lossesAgainst / Math.max(1, toughestRival.matchesAgainst) * 100).toFixed(2)
        }
      };
    };

    if (leagueId) {
      const bucket = leagueBuckets.get(String(leagueId));
      const single = bucket ? buildLeagueSynergy(bucket) : {
        leagueId: String(leagueId),
        leagueName: null,
        participatedMatches: 0,
        bestPairing: null,
        toughestRival: null
      };
      const payload = {
        playerId,
        leagueId: single.leagueId,
        participatedMatches: single.participatedMatches,
        bestPairing: single.bestPairing,
        toughestRival: single.toughestRival,
        generatedAt: new Date().toISOString()
      };
      inMemorySynergyCache.set(cacheKey, { data: payload, ts: Date.now() });
      ctx.body = payload;
      return;
    }

    // All leagues
    const leagues = [...leagueBuckets.values()].map(buildLeagueSynergy).filter(l => l.participatedMatches > 0);
    const response = {
      playerId,
      leagues,
      generatedAt: new Date().toISOString()
    };
    inMemorySynergyCache.set(cacheKey, { data: response, ts: Date.now() });
    ctx.body = response;

  } catch (err) {
    console.error('Synergy league logic error', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal error computing league synergy' };
  }
});

export default router;
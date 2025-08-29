import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import { League } from '../types/user';
import cache from '../utils/cache';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

const router = new Router({ prefix: '/players' });

// Add a GET /players endpoint with caching
router.get('/', async (ctx) => {
  const cacheKey = 'players_all';
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }
  try {
    const players = await UserModel.findAll({
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType'],
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
    cache.set(cacheKey, result, 600); // cache for 30 seconds
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

export default router; 
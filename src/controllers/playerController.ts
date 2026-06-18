import { Context } from 'koa';
import models from '../models';
import { Op } from 'sequelize';
import cache from '../utils/cache';
import sequelize from '../config/database';
import { registeredUserWhere } from '../utils/playerIdentity';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

export const getAllPlayers = async (ctx: Context) => {
  const cacheKey = 'players_all_registered_v2_ultra_fast';
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
        ...registeredUserWhere(),
        xp: { [Op.gt]: 0 }
      },
      order: [['xp', 'DESC']],
      limit: 50
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
    cache.set(cacheKey, result, 1800);
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error('Error fetching all players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
};

export const getPlayerById = async (ctx: Context) => {
  const { id } = ctx.params;
  
  try {
    const player = await UserModel.findByPk(id, {
      attributes: { exclude: ['password'] },
      include: [
        {
          model: LeagueModel,
          as: 'leagues',
          attributes: ['id', 'name', 'image']
        },
        {
          model: MatchStatistics,
          as: 'statistics'
        }
      ]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    ctx.body = {
      success: true,
      player
    };
  } catch (error) {
    console.error('Error fetching player:', error);
    ctx.throw(500, 'Failed to fetch player.');
  }
};

export const getPlayerStats = async (ctx: Context) => {
  const { id } = ctx.params;
  const { leagueId, year, seasonId } = ctx.query as { leagueId?: string; year?: string; seasonId?: string };

  try {
    const player = await UserModel.findByPk(id, {
      attributes: ['id'],
      include: [{ model: LeagueModel, as: 'leagues', attributes: ['id', 'name'] }]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    const matchWhere: Record<string, unknown> = {
      status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
    };
    let shouldUseSeasonScope = Boolean(seasonId && seasonId !== 'all');

    if (leagueId && leagueId !== 'all') {
      matchWhere.leagueId = leagueId;

      if (shouldUseSeasonScope) {
        const legacyUnseasonedMatches = await MatchModel.count({
          where: {
            leagueId,
            seasonId: { [Op.is]: null },
            status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] },
            deleted: false
          } as any
        });
        shouldUseSeasonScope = legacyUnseasonedMatches === 0;
      }
    }

    if (shouldUseSeasonScope) {
      matchWhere.seasonId = seasonId;
    }

    if (year && year !== 'all') {
      const y = Number(year);
      if (!Number.isNaN(y)) {
        matchWhere.date = {
          [Op.gte]: new Date(Date.UTC(y, 0, 1)),
          [Op.lt]: new Date(Date.UTC(y + 1, 0, 1))
        };
      }
    }

    const statsRows = await MatchStatistics.findAll({
      where: { user_id: id },
      include: [{
        model: MatchModel,
        as: 'match',
        where: matchWhere,
        attributes: [
          'id',
          'date',
          'leagueId',
          'seasonId',
          'homeTeamGoals',
          'awayTeamGoals',
          'status',
          'homeDefensiveImpactId',
          'awayDefensiveImpactId',
          'homeMentalityId',
          'awayMentalityId'
        ],
        include: [
          { model: UserModel, as: 'homeTeamUsers', attributes: ['id'] },
          { model: UserModel, as: 'awayTeamUsers', attributes: ['id'] }
        ]
      }],
      attributes: ['match_id', 'goals', 'assists', 'cleanSheets', 'defence', 'impact', 'xpAwarded']
    });

    const matchIds = Array.from(new Set(
      statsRows
        .map((s: any) => String(s.match_id || s.match?.id || '').trim())
        .filter(Boolean)
    ));

    const votes = matchIds.length
      ? await Vote.findAll({
          where: { matchId: { [Op.in]: matchIds }, votedForId: id },
          attributes: ['matchId'],
          raw: true
        })
      : [];

    const votesByMatch: Record<string, number> = {};
    (votes as any[]).forEach((v) => {
      const mid = String(v.matchId);
      votesByMatch[mid] = (votesByMatch[mid] || 0) + 1;
    });

    let played = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let goals = 0;
    let assists = 0;
    let cleanSheets = 0;
    let defence = 0;
    let totalImpact = 0;
    let totalXP = 0;
    let teamGoalsConceded = 0;
    let motmVotes = 0;
    let defensiveImpact = 0;
    let mentality = 0;

    statsRows.forEach((stat: any) => {
      const match = stat.match;
      if (!match) return;

      const matchId = String(match.id);
      const homeIds = (match.homeTeamUsers || []).map((u: any) => String(u.id));
      const awayIds = (match.awayTeamUsers || []).map((u: any) => String(u.id));
      const isHome = homeIds.includes(String(id));
      const isAway = awayIds.includes(String(id));
      if (!isHome && !isAway) return;

      const homeGoals = Number(match.homeTeamGoals || 0);
      const awayGoals = Number(match.awayTeamGoals || 0);
      const teamGoals = isHome ? homeGoals : awayGoals;
      const oppGoals = isHome ? awayGoals : homeGoals;

      played += 1;
      goals += Number(stat.goals || 0);
      assists += Number(stat.assists || 0);
      cleanSheets += Number(stat.cleanSheets || 0);
      defence += Number(stat.defence || 0);
      totalImpact += Number(stat.impact || 0);
      totalXP += Number(stat.xpAwarded || 0);
      motmVotes += Number(votesByMatch[matchId] || 0);
      teamGoalsConceded += oppGoals;
      if (String(match.homeDefensiveImpactId || '') === String(id) || String(match.awayDefensiveImpactId || '') === String(id)) {
        defensiveImpact += 1;
      }
      if (String(match.homeMentalityId || '') === String(id) || String(match.awayMentalityId || '') === String(id)) {
        mentality += 1;
      }

      if (teamGoals === oppGoals) draws += 1;
      else if (teamGoals > oppGoals) wins += 1;
      else losses += 1;
    });

    const avgImpact = played > 0 ? +(totalImpact / played).toFixed(2) : 0;
    const avgXP = played > 0 ? +(totalXP / played).toFixed(2) : 0;

    const totalStats = {
      // legacy keys (for old callers)
      goals,
      assists,
      motm: motmVotes,
      rating: avgImpact,
      matches: played,
      // canonical keys
      played,
      wins,
      draws,
      losses,
      cleanSheets,
      defence,
      impact: avgImpact,
      contributionIndex: avgImpact,
      motmVotes,
      defensiveImpact,
      defensiveImpactVotes: defensiveImpact,
      mentality,
      teamGoalsConceded,
      totalXP,
      xp: totalXP,
      avgXP,
    };

    const leagues = ((player as any).leagues || []).map((l: any) => ({
      id: String(l.id),
      name: l.name || 'League'
    }));

    ctx.body = {
      success: true,
      stats: totalStats,
      data: { leagues }
    };
  } catch (error) {
    console.error('Error fetching player stats:', error);
    ctx.throw(500, 'Failed to fetch player stats.');
  }
};

export const searchPlayers = async (ctx: Context) => {
  const { q } = ctx.query;

  if (!q || typeof q !== 'string') {
    ctx.throw(400, 'Search query is required');
    return;
  }

  try {
    const players = await UserModel.findAll({
      where: {
        ...registeredUserWhere(),
        [Op.or]: [
          { firstName: { [Op.iLike]: `%${q}%` } },
          { lastName: { [Op.iLike]: `%${q}%` } },
          { email: { [Op.iLike]: `%${q}%` } }
        ]
      },
      attributes: ['id', 'firstName', 'lastName', 'email', 'profilePicture', 'position', 'xp'],
      limit: 20
    });

    ctx.body = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        email: p.email,
        profilePicture: p.profilePicture,
        position: p.position,
        rating: p.xp || 0
      }))
    };
  } catch (error) {
    console.error('Error searching players:', error);
    ctx.throw(500, 'Failed to search players.');
  }
};

// GET COMPLETE PLAYER PROFILE WITH LEAGUES, MATCHES AND STATS
export const getPlayerProfile = async (ctx: Context) => {
  const { id } = ctx.params;
  const { leagueId, year } = ctx.query;

  try {
    // 1. Get player basic info
    const player = await UserModel.findByPk(id, {
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType', 'shirtNumber', 'email'],
      include: [{
        model: LeagueModel,
        as: 'leagues',
        attributes: ['id', 'name', 'image']
      }]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    // 2. Get player stats and related match data in small queries.
    // Avoid one large joined include (stats x votes x home players x away players),
    // which can create a cartesian result and hit the DB statement timeout.
    const statRows = await MatchStatistics.findAll({
      where: { user_id: id },
      attributes: ['id', 'goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact', 'rating', 'xpAwarded', 'match_id'],
      raw: true,
    });

    const uniqueMatchIds = Array.from(new Set((statRows as any[]).map((stat) => String(stat.match_id)).filter(Boolean)));
    const selectedLeagueId = typeof leagueId === 'string' && leagueId.trim() && leagueId !== 'all' ? leagueId.trim() : '';
    const selectedYear = typeof year === 'string' && year.trim() && year !== 'all' ? Number(year) : null;

    const allPublishedMatchRows: any[] = uniqueMatchIds.length
      ? await MatchModel.findAll({
          where: {
            id: { [Op.in]: uniqueMatchIds },
            status: 'RESULT_PUBLISHED',
          },
          attributes: ['date'],
          raw: true,
        })
      : [];
    const allYears = [...new Set(
      allPublishedMatchRows
        .map((match) => new Date(match.date).getFullYear())
        .filter((matchYear) => Number.isFinite(matchYear))
    )];

    const matchWhere: any = {
      id: { [Op.in]: uniqueMatchIds },
      status: 'RESULT_PUBLISHED',
    };
    if (selectedLeagueId) {
      matchWhere.leagueId = selectedLeagueId;
    }

    let matchRows: any[] = uniqueMatchIds.length
      ? await MatchModel.findAll({
          where: matchWhere,
          attributes: [
            'id',
            'date',
            'seasonId',
            'homeTeamName',
            'awayTeamName',
            'location',
            'leagueId',
            'end',
            'homeDefensiveImpactId',
            'awayDefensiveImpactId',
            'homeMentalityId',
            'awayMentalityId',
            'homeTeamGoals',
            'awayTeamGoals',
          ],
          raw: true,
        })
      : [];

    if (selectedYear && Number.isFinite(selectedYear)) {
      matchRows = matchRows.filter((match) => new Date(match.date).getFullYear() === selectedYear);
    }

    const visibleMatchIds = matchRows.map((match) => String(match.id));
    const visibleMatchIdSet = new Set(visibleMatchIds);
    const statsByMatchId = new Map<string, any>();
    (statRows as any[]).forEach((stat) => {
      const matchId = String(stat.match_id);
      if (visibleMatchIdSet.has(matchId)) {
        statsByMatchId.set(matchId, stat);
      }
    });

    const [voteRows, homeRows, awayRows] = visibleMatchIds.length
      ? await Promise.all([
          Vote.findAll({
            where: { matchId: { [Op.in]: visibleMatchIds } },
            attributes: ['voterId', 'votedForId', 'matchId'],
            raw: true,
          }),
          sequelize.query(
            `SELECT "matchId" FROM "UserHomeMatches" WHERE "userId" = :playerId AND "matchId" IN (:matchIds)`,
            { replacements: { playerId: id, matchIds: visibleMatchIds }, type: 'SELECT' as any }
          ),
          sequelize.query(
            `SELECT "matchId" FROM "UserAwayMatches" WHERE "userId" = :playerId AND "matchId" IN (:matchIds)`,
            { replacements: { playerId: id, matchIds: visibleMatchIds }, type: 'SELECT' as any }
          ),
        ])
      : [[], [], []];

    const votesByMatchId = new Map<string, any[]>();
    (voteRows as any[]).forEach((vote) => {
      const matchId = String(vote.matchId);
      if (!votesByMatchId.has(matchId)) votesByMatchId.set(matchId, []);
      votesByMatchId.get(matchId)!.push(vote);
    });

    const teamByMatchId = new Map<string, 'home' | 'away'>();
    (homeRows as any[]).forEach((row) => teamByMatchId.set(String(row.matchId), 'home'));
    (awayRows as any[]).forEach((row) => teamByMatchId.set(String(row.matchId), 'away'));

    const allStats = matchRows
      .map((match) => {
        const stat = statsByMatchId.get(String(match.id));
        if (!stat) return null;
        return {
          ...stat,
          match: {
            ...match,
            votes: votesByMatchId.get(String(match.id)) || [],
            playerTeam: teamByMatchId.get(String(match.id)) || null,
          },
        };
      })
      .filter(Boolean);

    // 3. Group matches by league
    const leaguesMap = new Map();
    const playerLeagues = (player as any).leagues || [];
    
    playerLeagues.forEach((league: any) => {
      leaguesMap.set(league.id, {
        id: league.id,
        name: league.name,
        matches: []
      });
    });

    // Add matches with player stats to respective leagues
    allStats.forEach((stat: any) => {
      const match = stat.match;
      if (!match) return;
      
      const leagueId = match.leagueId;
      if (!leaguesMap.has(leagueId)) {
        leaguesMap.set(leagueId, {
          id: leagueId,
          name: 'League',
          matches: []
        });
      }

      console.log(`🔍 Match ${match.id} data:`, {
        homeDefensiveImpactId: match.homeDefensiveImpactId,
        awayDefensiveImpactId: match.awayDefensiveImpactId,
        votesCount: match.votes?.length || 0,
        votes: match.votes
      });

      const isHomePlayer = match.playerTeam === 'home';
      const homeGoals = Number(match.homeTeamGoals || 0);
      const awayGoals = Number(match.awayTeamGoals || 0);
      const teamGoals = isHomePlayer ? homeGoals : awayGoals;
      const oppGoals = isHomePlayer ? awayGoals : homeGoals;
      const result: 'W' | 'D' | 'L' =
        teamGoals === oppGoals ? 'D' : (teamGoals > oppGoals ? 'W' : 'L');

      // Count MOTM votes for this player in this match
      const matchVotes = match.votes || [];
      const motmVotesCount = matchVotes.filter((v: any) => String(v.votedForId) === String(id)).length;

      leaguesMap.get(leagueId).matches.push({
        id: match.id,
        date: match.date,
        seasonId: match.seasonId,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        location: match.location,
        end: match.end,
        homeDefensiveImpactId: match.homeDefensiveImpactId,
        awayDefensiveImpactId: match.awayDefensiveImpactId,
        homeMentalityId: match.homeMentalityId,
        awayMentalityId: match.awayMentalityId,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        result,
        votes: match.votes || [],
        playerStats: {
          goals: stat.goals || 0,
          assists: stat.assists || 0,
          cleanSheets: stat.cleanSheets || 0,
          penalties: stat.penalties || 0,
          freeKicks: stat.freeKicks || 0,
          defence: stat.defence || 0,
          impact: stat.impact || 0,
          contributionIndex: stat.impact || 0,
          contributionIndexPercent: `${Number(stat.impact || 0)}%`,
          rating: stat.rating || 0,
          xpAwarded: Number(stat.xpAwarded || 0),
          result,
          teamGoals,
          opponentGoals: oppGoals,
          motmVotes: motmVotesCount
        }
      });
    });

    const leagues = Array.from(leaguesMap.values());

    // 4. Build response
    const response = {
      success: true,
      data: {
        player: {
          id: player.id,
          name: `${player.firstName} ${player.lastName}`,
          avatar: player.profilePicture,
          profilePicture: player.profilePicture,
          position: player.position,
          positionType: player.positionType,
          shirtNo: player.shirtNumber,
          rating: player.xp || 0
        },
        leagues: leagues,
        years: [...new Set(allStats.map((s: any) => new Date(s.match?.date).getFullYear()))].filter(Boolean),
        allYears,
        currentStats: {},
        accumulativeStats: {},
        trophies: {}
      }
    };

    ctx.body = response;
  } catch (error) {
    console.error('Error fetching player profile:', error);
    ctx.throw(500, 'Failed to fetch player profile.');
  }
};

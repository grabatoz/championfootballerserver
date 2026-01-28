import { Context } from 'koa';
import Match from '../models/Match';
import League from '../models/League';
import User from '../models/User';
import Season from '../models/Season';

export const createMatch = async (ctx: Context) => {
  const { leagueId } = ctx.params;
  
  // Get active season for this league
  const activeSeason = await Season.findOne({
    where: {
      leagueId,
      isActive: true
    }
  });

  if (!activeSeason) {
    ctx.throw(400, "No active season found for this league. Please create a season first.");
    return;
  }

  // Match creation logic here
  ctx.body = {
    success: true,
    message: "Match created",
    seasonId: activeSeason.id
  };
};

export const getAllMatches = async (ctx: Context) => {
  const matches = await Match.findAll({
    include: [
      { model: League, as: 'league' },
      { model: Season, as: 'season' }
    ],
    order: [['date', 'DESC']]
  });

  ctx.body = {
    success: true,
    matches
  };
};

export const getMatchById = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const match = await Match.findByPk(id, {
    include: [
      { model: League, as: 'league' },
      { model: Season, as: 'season' },
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' }
    ]
  });

  if (!match) {
    ctx.throw(404, 'Match not found');
    return;
  }

  ctx.body = {
    success: true,
    match
  };
};

export const updateMatch = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const match = await Match.findByPk(id);
  if (!match) {
    ctx.throw(404, 'Match not found');
    return;
  }

  // Update logic here
  ctx.body = {
    success: true,
    message: "Match updated"
  };
};

export const deleteMatch = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const match = await Match.findByPk(id);
  if (!match) {
    ctx.throw(404, 'Match not found');
    return;
  }

  await match.destroy();

  ctx.status = 204;
};

export const getMatchesBySeason = async (ctx: Context) => {
  const { seasonId } = ctx.params;
  
  const matches = await Match.findAll({
    where: { seasonId },
    include: [
      { model: League, as: 'league' },
      { model: Season, as: 'season' }
    ],
    order: [['date', 'DESC']]
  });

  ctx.body = {
    success: true,
    matches
  };
};

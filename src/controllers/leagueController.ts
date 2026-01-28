import { Context } from 'koa';
import League from '../models/League';
import User from '../models/User';
import Match from '../models/Match';
import { where, fn, col } from 'sequelize';

export const createLeague = async (ctx: Context) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  // This function will be populated with league creation logic
  // Extract from leagues.ts route
  ctx.body = {
    success: true,
    message: "League controller ready"
  };
};

export const getAllLeagues = async (ctx: Context) => {
  // Get all leagues logic here
  ctx.body = {
    success: true,
    leagues: []
  };
};

export const getLeagueById = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const league = await League.findByPk(id, {
    include: [
      { model: User, as: 'members' },
      { model: User, as: 'administeredLeagues' },
      { model: Match, as: 'matches' }
    ]
  });

  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }

  ctx.body = {
    success: true,
    league
  };
};

export const updateLeague = async (ctx: Context) => {
  const { id } = ctx.params;
  
  // Update league logic
  ctx.body = {
    success: true,
    message: "League updated"
  };
};

export const deleteLeague = async (ctx: Context) => {
  const { id } = ctx.params;
  
  const league = await League.findByPk(id);
  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }

  await league.destroy();

  ctx.status = 204;
};

export const joinLeague = async (ctx: Context) => {
  const { inviteCode } = ctx.request.body as { inviteCode: string };
  
  if (!inviteCode) {
    ctx.throw(400, "Invite code is required");
    return;
  }

  const league = await League.findOne({
    where: { inviteCode }
  });

  if (!league) {
    ctx.throw(404, "League not found with this invite code");
    return;
  }

  // Add user to league and active season
  const isAlreadyMember = await (league as any).hasMember(ctx.state.user.userId);

  if (isAlreadyMember) {
    ctx.body = {
      success: false,
      message: "You have already joined this league."
    };
    return;
  }

  const user = await User.findByPk(ctx.state.user.userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  await (league as any).addMember(user.id);

  // Add to active season
  const { Season } = require('../models');
  const activeSeason = await Season.findOne({
    where: {
      leagueId: league.id,
      isActive: true
    }
  });

  if (activeSeason) {
    await (activeSeason as any).addPlayer(user.id);
    console.log(`✅ User added to ${activeSeason.name}`);
  }

  ctx.body = {
    success: true,
    message: "Successfully joined league",
    league: {
      id: league.id,
      name: league.name
    }
  };
};

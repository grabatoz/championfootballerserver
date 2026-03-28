import { Context } from 'koa';
import models from '../models';
import sequelize from '../config/database';
import { QueryTypes, Op, fn, col } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { sendCaptainConfirmations, notifyCaptainConfirmed, notifyCaptainRevision } from '../modules/notifications';
import Notification from '../models/Notification';
import Season from '../models/Season';
import { checkAndCompleteLeagueAfterMatch, isLeagueLocked } from '../utils/leagueCompletion';

const { Match, Vote, User, MatchStatistics, League, MatchGuest, MatchAvailability } = models;

const normalizeTeam = (t: any): 'home' | 'away' =>
  String(t).toLowerCase() === 'away' ? 'away' : 'home';

const MIN_TOTAL_PLAYERS_FOR_SCORE_UPLOAD = 8;
const MIN_REGISTERED_PLAYERS_FOR_SCORE_UPLOAD = 6;
const MIN_REGISTERED_PLAYERS_MESSAGE = 'A minimum of 6 registered players is required to choose teams';
const MIN_TOTAL_PLAYERS_FOR_SCORE_MESSAGE = 'A minimum of 8 total players (including at least 6 registered league players) is required before uploading match scores.';
const clampPercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const getMatchPlayerCounts = async (matchId: string): Promise<{ registeredPlayers: number; totalPlayers: number }> => {
  const homeTeamUserIds = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );
  const awayTeamUserIds = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );
  const guestCount = await MatchGuest.count({ where: { matchId } });
  const registeredPlayers = new Set<string>([
    ...homeTeamUserIds.map((u) => String(u.userId)),
    ...awayTeamUserIds.map((u) => String(u.userId)),
  ]).size;
  return { registeredPlayers, totalPlayers: registeredPlayers + guestCount };
};

const getScoreUploadValidationMessage = (registeredPlayers: number, totalPlayers: number): string | null => {
  if (registeredPlayers < MIN_REGISTERED_PLAYERS_FOR_SCORE_UPLOAD) {
    return MIN_REGISTERED_PLAYERS_MESSAGE;
  }
  if (totalPlayers < MIN_TOTAL_PLAYERS_FOR_SCORE_UPLOAD) {
    return MIN_TOTAL_PLAYERS_FOR_SCORE_MESSAGE;
  }
  return null;
};

// CREATE MATCH - Always assigns to active season
export const createMatch = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const {
    leagueId,
    date,
    start,
    end,
    location,
    homeTeamName,
    awayTeamName,
    homeTeamImage,
    awayTeamImage,
    notes
  } = ctx.request.body as any;

  if (!leagueId) {
    ctx.throw(400, 'leagueId is required');
    return;
  }

  if (!date || !start || !end) {
    ctx.throw(400, 'date, start and end times are required');
    return;
  }

  try {
    // Find the active season for this league
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

    console.log(`📅 Creating match for league ${leagueId} in active season ${activeSeason.id} (Season ${activeSeason.seasonNumber})`);

    // Create match with seasonId from active season
    const match = await Match.create({
      id: uuidv4(),
      leagueId,
      seasonId: activeSeason.id, // 🔥 Always use active season
      date: new Date(date),
      start: new Date(start),
      end: new Date(end),
      location: location || '',
      homeTeamName: homeTeamName || 'Home Team',
      awayTeamName: awayTeamName || 'Away Team',
      homeTeamImage: homeTeamImage || null,
      awayTeamImage: awayTeamImage || null,
      notes: notes || null,
      status: 'SCHEDULED',
      homeTeamGoals: 0,
      awayTeamGoals: 0
    });

    console.log(`✅ Match created: ${match.id} in Season ${activeSeason.seasonNumber}`);

    // Clear caches
    try {
      cache.clearPattern(`league_${leagueId}`);
      cache.clearPattern(`matches_league_${leagueId}`);
    } catch (e) {
      console.warn('Cache clear failed', e);
    }

    ctx.status = 201;
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
        notes: match.notes,
        status: match.status
      },
      message: `Match created in Season ${activeSeason.seasonNumber}`
    };
  } catch (err) {
    console.error('Create match error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to create match' };
  }
};

const normalizePlayerOrGuestId = (value: string): string => {
  const v = String(value || '').trim();
  if (v.startsWith('guest-')) return v.slice(6);
  return v;
};

// Resolve player or guest ID to user ID
async function resolveTargetUserIdForMatch(playerOrGuestId: string, matchId: string): Promise<string> {
  const normalizedId = normalizePlayerOrGuestId(playerOrGuestId);
  const existingUser = await User.findByPk(normalizedId);
  if (existingUser) return String(existingUser.id);

  const guest = await (models as any).MatchGuest.findOne({ where: { id: normalizedId, matchId } });
  if (!guest) {
    throw new Error('Player not found');
  }

  const guestMirror = await User.findOne({ where: { provider: 'guest', providerId: String(guest.id) } });
  if (guestMirror) return String(guestMirror.id);

  const email = `guest_${guest.id}@guest.local`;
  const firstName = String((guest as any).firstName || 'Guest');
  const lastName = String((guest as any).lastName || 'Player');
  const created = await User.create({
    email,
    firstName,
    lastName,
    password: `guest:${String(guest.id)}`,
    provider: 'guest',
    providerId: String(guest.id),
  } as any);
  return String(created.id);
}

async function getMatchGuestMirrorMaps(matchId: string): Promise<{
  mirrorToDisplay: Map<string, string>;
  displayToMirror: Map<string, string>;
}> {
  const mirrorToDisplay = new Map<string, string>();
  const displayToMirror = new Map<string, string>();

  const guests = await (models as any).MatchGuest.findAll({
    where: { matchId },
    attributes: ['id']
  });
  const guestIds = (guests || []).map((g: any) => String(g.id));
  if (!guestIds.length) return { mirrorToDisplay, displayToMirror };

  const guestMirrors = await User.findAll({
    where: {
      provider: 'guest',
      providerId: { [Op.in]: guestIds }
    },
    attributes: ['id', 'providerId']
  } as any);

  (guestMirrors || []).forEach((u: any) => {
    const mirrorId = String(u.id);
    const providerId = String(u.providerId || '');
    if (!providerId) return;
    const displayId = `guest-${providerId}`;
    mirrorToDisplay.set(mirrorId, displayId);
    // Accept both prefixed and raw guest IDs from client payloads.
    displayToMirror.set(displayId, mirrorId);
    displayToMirror.set(providerId, mirrorId);
  });

  return { mirrorToDisplay, displayToMirror };
}

async function getPlayerTeamForMatch(userId: string, matchId: string): Promise<'home' | 'away' | null> {
  const uid = String(userId);
  const homeTeamUserIds = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );
  const awayTeamUserIds = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );

  if (homeTeamUserIds.some(u => String(u.userId) === uid)) return 'home';
  if (awayTeamUserIds.some(u => String(u.userId) === uid)) return 'away';

  const user = await User.findByPk(uid, { attributes: ['id', 'provider', 'providerId'] } as any);
  const provider = String((user as any)?.provider || '');
  const providerId = String((user as any)?.providerId || '');
  if (provider !== 'guest' || !providerId) return null;

  const guest = await (models as any).MatchGuest.findOne({
    where: { id: providerId, matchId },
    attributes: ['id', 'team']
  });
  if (!guest) return null;
  return normalizeTeam((guest as any).team);
}

async function getTeamResultForUserInMatch(
  userId: string,
  matchId: string,
  homeGoals: number,
  awayGoals: number
): Promise<'win' | 'draw' | 'lose'> {
  if (homeGoals === awayGoals) return 'draw';
  const team = await getPlayerTeamForMatch(userId, matchId);
  if (team === 'home') return homeGoals > awayGoals ? 'win' : 'lose';
  if (team === 'away') return awayGoals > homeGoals ? 'win' : 'lose';
  return 'lose';
}

// Recompute canonical XP for this match from current stats + votes + captain picks.
// This keeps users.xp and match_statistics.xp_awarded in sync whenever votes/scores change.
async function recalculateMatchXPForCurrentState(matchId: string, ensureUserIds: Array<string | null | undefined> = []): Promise<void> {
  const dedupEnsureIds = Array.from(new Set(
    ensureUserIds
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  ));

  // Ensure rows exist for any explicitly passed users (for vote-only players).
  for (const uid of dedupEnsureIds) {
    await MatchStatistics.findOrCreate({
      where: { match_id: matchId, user_id: uid },
      defaults: {
        match_id: matchId,
        user_id: uid,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        penalties: 0,
        freeKicks: 0,
        yellowCards: 0,
        redCards: 0,
        defence: 0,
        impact: 0,
        minutesPlayed: 0,
        rating: 0,
        xpAwarded: 0
      }
    });
  }

  const match = await Match.findByPk(matchId, {
    attributes: [
      'id',
      'homeTeamGoals',
      'awayTeamGoals',
      'homeDefensiveImpactId',
      'awayDefensiveImpactId',
      'homeMentalityId',
      'awayMentalityId'
    ]
  });
  if (!match) return;

  const homeGoals = Number(match.homeTeamGoals || 0);
  const awayGoals = Number(match.awayTeamGoals || 0);

  const statsRows = await sequelize.query<{
    user_id: string;
    goals: number;
    assists: number;
    clean_sheets: number;
    xp_awarded: number;
  }>(
    `SELECT
       user_id,
       COALESCE(goals, 0) AS goals,
       COALESCE(assists, 0) AS assists,
       COALESCE(clean_sheets, 0) AS clean_sheets,
       COALESCE(xp_awarded, 0) AS xp_awarded
     FROM match_statistics
     WHERE match_id = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );

  if (!statsRows.length) return;

  const votes = await sequelize.query<{ votedForId: string }>(
    `SELECT "votedForId" FROM "Votes" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );

  const voteCountByPlayer: Record<string, number> = {};
  for (const v of votes) {
    const vid = String(v.votedForId || '').trim();
    if (!vid) continue;
    voteCountByPlayer[vid] = (voteCountByPlayer[vid] || 0) + 1;
  }

  // Same tie-break behavior everywhere: highest votes, then lexical user id.
  const motmSorted = Object.entries(voteCountByPlayer).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]));
  });
  const motmWinnerId = motmSorted.length > 0 && motmSorted[0][1] > 0 ? String(motmSorted[0][0]) : null;

  const homeDefensiveId = String((match as any).homeDefensiveImpactId || '');
  const awayDefensiveId = String((match as any).awayDefensiveImpactId || '');
  const homeMentalityId = String((match as any).homeMentalityId || '');
  const awayMentalityId = String((match as any).awayMentalityId || '');

  const tx = await sequelize.transaction();
  try {
    for (const row of statsRows) {
      const userId = String(row.user_id);
      const goals = Math.max(0, Number(row.goals) || 0);
      const assists = Math.max(0, Number(row.assists) || 0);
      const cleanSheets = Math.max(0, Number(row.clean_sheets) || 0);
      const prevAwarded = Math.max(0, Number(row.xp_awarded) || 0);

      const teamResult = await getTeamResultForUserInMatch(userId, matchId, homeGoals, awayGoals);

      let nextAwarded = 0;
      if (teamResult === 'win') nextAwarded += xpPointsTable.winningTeam;
      else if (teamResult === 'draw') nextAwarded += xpPointsTable.draw;
      else nextAwarded += xpPointsTable.losingTeam;

      nextAwarded += goals * (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose);
      nextAwarded += assists * (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose);
      nextAwarded += cleanSheets * xpPointsTable.cleanSheet;

      const voteCount = voteCountByPlayer[userId] || 0;
      nextAwarded += voteCount * (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose);

      if (motmWinnerId && motmWinnerId === userId) {
        nextAwarded += teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose;
      }

      const isDefensivePick = userId === homeDefensiveId || userId === awayDefensiveId;
      if (isDefensivePick) {
        nextAwarded += teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
      }

      const isMentalityPick = userId === homeMentalityId || userId === awayMentalityId;
      if (isMentalityPick) {
        nextAwarded += teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
      }

      nextAwarded = Math.max(0, Math.round(nextAwarded));
      if (nextAwarded === prevAwarded) continue;

      await sequelize.query(
        `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3`,
        { bind: [nextAwarded, matchId, userId], transaction: tx }
      );

      const userRow = await sequelize.query<{ xp: number }>(
        `SELECT xp FROM users WHERE id = $1 FOR UPDATE`,
        { bind: [userId], type: QueryTypes.SELECT, transaction: tx }
      );
      if (userRow.length > 0) {
        const currentXP = Math.max(0, Number(userRow[0].xp) || 0);
        const delta = nextAwarded - prevAwarded;
        const finalXP = Math.max(0, currentXP + delta);
        if (finalXP !== currentXP) {
          await sequelize.query(
            `UPDATE users SET xp = $1 WHERE id = $2`,
            { bind: [finalXP, userId], transaction: tx }
          );
        }
      }
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Vote for MOTM
export const voteForMotm = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }
  const matchId = ctx.params.id;
  const voterId = ctx.state.user.userId;
  const { votedForId } = ctx.request.body as { votedForId?: string | null };

  // Check if the league is locked (completed for more than 24 hours)
  const match = await Match.findByPk(matchId, { attributes: ['id', 'leagueId'] });
  if (match?.leagueId) {
    const lockStatus = await isLeagueLocked(match.leagueId);
    if (lockStatus.locked) {
      ctx.throw(403, 'This league has been completed for over 24 hours. Points are now locked and cannot be updated.');
      return;
    }
  }

  // Resolve incoming selected target (supports regular users + guests).
  let targetUserId: string | null = null;
  if (votedForId) {
    try {
      targetUserId = await resolveTargetUserIdForMatch(String(votedForId), matchId);
    } catch {
      ctx.throw(400, 'Selected player is invalid for this match.');
      return;
    }

    const targetTeam = await getPlayerTeamForMatch(targetUserId, matchId);
    if (!targetTeam) {
      ctx.throw(400, 'Selected player is not part of this match.');
      return;
    }
    if (String(voterId) === String(targetUserId)) {
      ctx.throw(400, 'You cannot vote for yourself.');
      return;
    }
  }

  // Get old vote to subtract XP from previous voted player
  const oldVote = await Vote.findOne({ where: { matchId, voterId } });
  const oldVotedForId = oldVote?.votedForId;

  if (!votedForId) {
    // Removing vote - subtract XP from previously voted player
    if (oldVotedForId) {
      try {
        const match = await Match.findByPk(matchId);
        if (match) {
          const homeGoals = match.homeTeamGoals ?? 0;
          const awayGoals = match.awayTeamGoals ?? 0;
          const teamResult = await getTeamResultForUserInMatch(String(oldVotedForId), matchId, homeGoals, awayGoals);
          
          const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
          const userResult = await sequelize.query(
            `SELECT id, "firstName", xp FROM users WHERE id = $1`,
            { bind: [oldVotedForId], type: QueryTypes.SELECT }
          );
          if (userResult.length > 0) {
            const user = userResult[0] as any;
            const newXP = Math.max(0, (user.xp || 0) - voteXP);
            await sequelize.query(`UPDATE users SET xp = $1 WHERE id = $2`, { bind: [newXP, oldVotedForId] });
            console.log(`🗳️ Vote removed - ${user.firstName} lost -${voteXP} XP`);

            // Also subtract from match_statistics.xp_awarded to keep league table in sync
            try {
              const existingStats = await sequelize.query(
                `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
                { bind: [matchId, oldVotedForId], type: QueryTypes.SELECT }
              );
              if (existingStats.length > 0) {
                const prevXpAwarded = (existingStats[0] as any)?.xp_awarded || 0;
                const newXpAwarded = Math.max(0, prevXpAwarded - voteXP);
                await sequelize.query(
                  `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3`,
                  { bind: [newXpAwarded, matchId, oldVotedForId] }
                );
                console.log(`🗳️ match_statistics.xp_awarded reduced: ${prevXpAwarded} → ${newXpAwarded}`);
              }
            } catch (statsErr) {
              console.error('⚠️ Could not update match_statistics.xp_awarded for vote removal:', statsErr);
            }
          }
        }
      } catch (e) { console.error('Error removing vote XP:', e); }
    }
    await Vote.destroy({ where: { matchId, voterId } });
    try {
      await recalculateMatchXPForCurrentState(matchId, [oldVotedForId]);
    } catch (recalcErr) {
      console.error('Could not recalculate match XP after vote removal:', recalcErr);
    }
    try { cache.clearPattern(`match_votes_${matchId}_`); } catch {}
    ctx.status = 200;
    ctx.body = { success: true, message: 'Vote removed.' };
    return;
  }

  // If changing vote, subtract XP from old voted player first
  if (oldVotedForId && targetUserId && oldVotedForId !== targetUserId) {
    try {
      const match = await Match.findByPk(matchId);
      if (match) {
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        const teamResult = await getTeamResultForUserInMatch(String(oldVotedForId), matchId, homeGoals, awayGoals);
        
        const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [oldVotedForId], type: QueryTypes.SELECT }
        );
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const newXP = Math.max(0, (user.xp || 0) - voteXP);
          await sequelize.query(`UPDATE users SET xp = $1 WHERE id = $2`, { bind: [newXP, oldVotedForId] });
          console.log(`🗳️ Vote changed - ${user.firstName} lost -${voteXP} XP`);

          // Also subtract from match_statistics.xp_awarded to keep league table in sync
          try {
            const existingStats = await sequelize.query(
              `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
              { bind: [matchId, oldVotedForId], type: QueryTypes.SELECT }
            );
            if (existingStats.length > 0) {
              const prevXpAwarded = (existingStats[0] as any)?.xp_awarded || 0;
              const newXpAwarded = Math.max(0, prevXpAwarded - voteXP);
              await sequelize.query(
                `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3`,
                { bind: [newXpAwarded, matchId, oldVotedForId] }
              );
              console.log(`🗳️ match_statistics.xp_awarded reduced (vote change): ${prevXpAwarded} → ${newXpAwarded}`);
            }
          } catch (statsErr) {
            console.error('⚠️ Could not update match_statistics.xp_awarded for vote change:', statsErr);
          }
        }
      }
    } catch (e) { console.error('Error removing old vote XP:', e); }
  }

  await Vote.destroy({ where: { matchId, voterId } });
  if (!targetUserId) {
    ctx.throw(400, 'Selected player is invalid for this match.');
    return;
  }
  await Vote.create({ matchId, voterId, votedForId: targetUserId });

  console.log(`🗳️ Vote created - voterId: ${voterId}, votedForId: ${targetUserId}, matchId: ${matchId}`);
  console.log(`🗳️ Old vote was for: ${oldVotedForId || 'none'}`);

  // 🗳️ Award XP to the voted player immediately (skip if same player)
  if (!oldVotedForId || oldVotedForId !== targetUserId) {
    console.log(`🗳️ Processing XP award for ${targetUserId}...`);
    try {
      const match = await Match.findByPk(matchId);
      console.log(`🗳️ Match found: ${match ? 'YES' : 'NO'}`);
      
      if (match) {
        // Determine if voted player's team won, lost, or drew
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        console.log(`🗳️ Score: Home ${homeGoals} - Away ${awayGoals}`);
        
        const team = await getPlayerTeamForMatch(targetUserId, matchId);
        console.log(`🗳️ VotedFor team: ${team || 'unknown'}`);

        const teamResult = await getTeamResultForUserInMatch(targetUserId, matchId, homeGoals, awayGoals);
        console.log(`🗳️ Team result: ${teamResult}`);
        
        // Award motmVote XP for this single vote
        const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
        console.log(`🗳️ Vote XP to award: ${voteXP}`);
        
        // Get current user XP and add vote XP
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [targetUserId], type: QueryTypes.SELECT }
        );
        console.log(`🗳️ User query result: ${JSON.stringify(userResult)}`);
        
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const currentXP = user.xp || 0;
          const newXP = currentXP + voteXP;
          
          console.log(`🗳️ Updating user XP: ${currentXP} + ${voteXP} = ${newXP}`);
          
          const updateResult = await sequelize.query(
            `UPDATE users SET xp = $1 WHERE id = $2 RETURNING id, xp`,
            { bind: [newXP, targetUserId], type: QueryTypes.UPDATE }
          );
          console.log(`🗳️ Update result: ${JSON.stringify(updateResult)}`);
          
          // Also update match_statistics.xp_awarded to keep league table XP in sync
          try {
            const existingStats = await sequelize.query(
              `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
              { bind: [matchId, targetUserId], type: QueryTypes.SELECT }
            );
            if (existingStats.length > 0) {
              const prevXpAwarded = (existingStats[0] as any)?.xp_awarded || 0;
              const newXpAwarded = prevXpAwarded + voteXP;
              await sequelize.query(
                `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3`,
                { bind: [newXpAwarded, matchId, targetUserId] }
              );
              console.log(`🗳️ match_statistics.xp_awarded updated: ${prevXpAwarded} → ${newXpAwarded}`);
            }
          } catch (statsErr) {
            console.error('⚠️ Could not update match_statistics.xp_awarded for vote:', statsErr);
          }
          
          // Verify the update
          const verifyResult = await sequelize.query(
            `SELECT id, "firstName", xp FROM users WHERE id = $1`,
            { bind: [targetUserId], type: QueryTypes.SELECT }
          );
          console.log(`🗳️ VERIFIED - User XP after update: ${JSON.stringify(verifyResult)}`);
          
          console.log(`✅ MOTM Vote XP awarded! ${user.firstName} received +${voteXP} XP (${currentXP} → ${newXP})`);
        } else {
          console.log(`❌ User not found with id: ${targetUserId}`);
        }
      }
    } catch (voteXpErr: any) {
      console.error('⚠️ Error awarding vote XP:', voteXpErr);
      console.error('⚠️ Error message:', voteXpErr?.message);
      console.error('⚠️ Error stack:', voteXpErr?.stack);
    }
  } else {
    console.log(`🗳️ Skipping XP - same player voted again`);
  }

  try {
    await recalculateMatchXPForCurrentState(matchId, [oldVotedForId, targetUserId]);
  } catch (recalcErr) {
    console.error('Could not recalculate match XP after vote submit/change:', recalcErr);
  }

  try {
    const match = await Match.findByPk(matchId);
    if (match && match.leagueId) {
      const votedUser = await User.findByPk(String(targetUserId), { attributes: ['id', 'provider'] } as any);
      if (String((votedUser as any)?.provider || '') !== 'guest') {
        const cacheKey = `leaderboard_motm_${match.leagueId}_all`;
        cache.updateLeaderboard(cacheKey, { playerId: targetUserId, value: 1 });
      }
    }
  } catch (e) {
    console.warn('MOTM leaderboard cache update failed', e);
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', attributes: ['id', 'name'] }]
    });

    if (match) {
      const homePlayerIds = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );

      const awayPlayerIds = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );

      const allPlayerIds = [
        ...homePlayerIds.map(p => p.userId),
        ...awayPlayerIds.map(p => p.userId)
      ];

      const uniquePlayerIds = Array.from(new Set(allPlayerIds))
        .filter(id => id !== targetUserId);

      const votedForPlayer = await User.findByPk(String(targetUserId));
      const voterPlayer = await User.findByPk(voterId);

      if (votedForPlayer && voterPlayer) {
        const notificationPromises = uniquePlayerIds.map(playerId =>
          Notification.create({
            user_id: playerId,
            type: 'MOTM_VOTE',
            title: 'Man of the Match Vote',
            body: `${voterPlayer.firstName} ${voterPlayer.lastName} voted for ${votedForPlayer.firstName} ${votedForPlayer.lastName} as MOTM`,
            meta: JSON.stringify({
              matchId,
              leagueId: match.leagueId,
              leagueName: (match as any).league?.name,
              voterId,
              votedForId: targetUserId,
              voterName: `${voterPlayer.firstName} ${voterPlayer.lastName}`,
              votedForName: `${votedForPlayer.firstName} ${votedForPlayer.lastName}`
            }),
            read: false
          } as any)
        );

        await Promise.all(notificationPromises);
        console.log(`✅ Sent ${uniquePlayerIds.length} MOTM vote notifications`);
      }
    }
  } catch (notifErr) {
    console.error('Error sending MOTM vote notifications:', notifErr);
  }

  try { cache.clearPattern(`match_votes_${matchId}_`); } catch {}

  ctx.body = { success: true, message: 'Vote recorded successfully' };
};

// Set match availability
export const setMatchAvailability = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const { matchId } = ctx.params;
  const userId = ctx.state.user.userId;
  const body = ctx.request.body as { available?: boolean | string };
  
  // Check for action in query params first (client sends ?action=available or ?action=unavailable)
  const actionQuery = ctx.query.action as string | undefined;
  
  // Handle both query param and body
  let available: boolean;
  if (actionQuery) {
    // Query param takes precedence
    available = actionQuery.toLowerCase() === 'available';
  } else if (typeof body.available === 'boolean') {
    available = body.available;
  } else if (typeof body.available === 'string') {
    available = body.available.toLowerCase() === 'true' || body.available.toLowerCase() === 'available';
  } else {
    // Default to true if nothing provided
    available = true;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const [availability, created] = await MatchAvailability.findOrCreate({
      where: { match_id: matchId, user_id: userId },
      defaults: { match_id: matchId, user_id: userId, status: available ? 'available' : 'unavailable' }
    });

    if (!created) {
      const updateData: any = { status: available ? 'available' : 'unavailable' };
      // Keep acceptance order accurate: when user marks available, refresh created_at as acceptance time.
      if (available) updateData.created_at = new Date();
      await availability.update(updateData);
    }

    ctx.body = { success: true, message: 'Availability updated', available };
  } catch (err) {
    console.error('Set availability error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to set availability' };
  }
};

// Update match goals
export const updateMatchGoals = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { homeTeamGoals, awayTeamGoals } = ctx.request.body as { homeTeamGoals?: number; awayTeamGoals?: number };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update goals');
      return;
    }

    const { registeredPlayers, totalPlayers } = await getMatchPlayerCounts(matchId);
    const validationMessage = getScoreUploadValidationMessage(registeredPlayers, totalPlayers);
    if (validationMessage) {
      ctx.status = 400;
      ctx.body = { success: false, message: validationMessage };
      return;
    }

    const updateData: any = {};
    if (typeof homeTeamGoals === 'number') updateData.homeTeamGoals = homeTeamGoals;
    if (typeof awayTeamGoals === 'number') updateData.awayTeamGoals = awayTeamGoals;

    // Admin-submitted results are published immediately — no captain confirmation required
    updateData.status = 'RESULT_PUBLISHED';
    updateData.resultPublishedAt = new Date();

    await match.update(updateData);
    console.log(`✅ Admin published result for match ${matchId} — status set to RESULT_PUBLISHED`);

    try {
      await recalculateMatchXPForCurrentState(matchId);
    } catch (recalcErr) {
      console.error('Could not recalculate match XP after score update:', recalcErr);
    }

    // Send informational notification to captains (optional, no longer gates the result)
    try {
      console.log('📧 Sending captain confirmation notifications for match:', matchId);
      await sendCaptainConfirmations(match, (match as any).league);
      console.log('✅ Captain notifications sent successfully');
    } catch (notifErr) {
      console.error('❌ Failed to send captain notifications:', notifErr);
    }

    // Check if this match completion triggers season/league completion
    try {
      const completionResult = await checkAndCompleteLeagueAfterMatch(matchId);
      if (completionResult.seasonCompleted) {
        console.log(`🏆 Season completed after match ${matchId}!`);
      }
      if (completionResult.leagueCompleted) {
        console.log(`🏆🏆 League completed after match ${matchId}!`);
      }
    } catch (completionErr) {
      console.error('Failed to check league completion:', completionErr);
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        status: match.status
      }
    };
  } catch (err) {
    console.error('Update goals error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update goals' };
  }
};

// Update match note
export const updateMatchNote = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { note } = ctx.request.body as { note?: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    await match.update({ note: note || null } as any);

    ctx.body = {
      success: true,
      match: { id: match.id, note: (match as any).note }
    };
  } catch (err) {
    console.error('Update note error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update note' };
  }
};

// Confirm match result (for captains)
export const confirmMatchResult = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = String(ctx.state.user.userId);

  console.log(`🔔 confirmMatchResult called — matchId: ${matchId}, userId: ${userId}`);

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', attributes: ['id', 'name'] }]
    });

    if (!match) {
      console.warn(`❌ Match ${matchId} not found`);
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    // Check if user is a captain (use String() for safe comparison)
    const isHomeCaptain = String(match.homeCaptainId || '') === userId;
    const isAwayCaptain = String(match.awayCaptainId || '') === userId;

    console.log(`   homeCaptainId: ${match.homeCaptainId} (${typeof match.homeCaptainId})`);
    console.log(`   awayCaptainId: ${match.awayCaptainId} (${typeof match.awayCaptainId})`);
    console.log(`   userId: ${userId} — isHome: ${isHomeCaptain}, isAway: ${isAwayCaptain}`);

    if (!isHomeCaptain && !isAwayCaptain) {
      console.warn(`❌ User ${userId} is not a captain of match ${matchId}`);
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only team captains can confirm results' };
      return;
    }

    // Handle rejection / revision suggestion
    const body = ctx.request.body as any;
    const decision = body?.decision;

    if (decision === 'NO') {
      const sugHome = parseInt(String(body?.suggestedHomeGoals), 10);
      const sugAway = parseInt(String(body?.suggestedAwayGoals), 10);

      const revisionData: any = {
        status: 'REVISION_REQUESTED',
        suggestedByCaptainId: userId,
      };
      if (Number.isFinite(sugHome) && sugHome >= 0) revisionData.suggestedHomeGoals = sugHome;
      if (Number.isFinite(sugAway) && sugAway >= 0) revisionData.suggestedAwayGoals = sugAway;

      await match.update(revisionData);
      console.log(`❌ Captain ${userId} rejected result for match ${matchId} — suggested ${sugHome}-${sugAway}`);

      // Notify league admins about the revision
      try {
        await notifyCaptainRevision(match, userId, sugHome, sugAway);
        console.log(`📨 Admin notified about revision for match ${matchId}`);
      } catch (notifErr) {
        console.error('Failed to send revision notification:', notifErr);
      }

      ctx.body = {
        success: true,
        message: 'Revision suggestion submitted',
        confirmed: false,
        bothConfirmed: false,
        match: {
          id: match.id,
          status: 'REVISION_REQUESTED',
          homeCaptainConfirmed: match.homeCaptainConfirmed,
          awayCaptainConfirmed: match.awayCaptainConfirmed,
        },
      };
      return;
    }

    // Update confirmation status
    const updateData: any = {};
    if (isHomeCaptain) {
      updateData.homeCaptainConfirmed = true;
      console.log(`✅ Home captain ${userId} confirmed result for match ${matchId}`);
    }
    if (isAwayCaptain) {
      updateData.awayCaptainConfirmed = true;
      console.log(`✅ Away captain ${userId} confirmed result for match ${matchId}`);
    }

    await match.update(updateData);

    // Check if both captains have confirmed
    const bothConfirmed = 
      (isHomeCaptain ? true : match.homeCaptainConfirmed) && 
      (isAwayCaptain ? true : match.awayCaptainConfirmed);

    console.log(`🔍 Captain confirmation check for match ${matchId}:`);
    console.log(`   isHomeCaptain: ${isHomeCaptain}, isAwayCaptain: ${isAwayCaptain}`);
    console.log(`   homeCaptainConfirmed: ${match.homeCaptainConfirmed}, awayCaptainConfirmed: ${match.awayCaptainConfirmed}`);
    console.log(`   bothConfirmed: ${bothConfirmed}`);

    if (bothConfirmed) {
      // Update match status to RESULT_PUBLISHED
      await match.update({ 
        status: 'RESULT_PUBLISHED',
        resultPublishedAt: new Date()
      });
      console.log(`🎉 Both captains confirmed - Match ${matchId} status updated to RESULT_PUBLISHED`);

      // NOTE: XP is now awarded IMMEDIATELY when stats are submitted (in submitMatchStats)
      // NO MORE XP awarding here to prevent DOUBLE XP
      console.log(`ℹ️ XP already awarded during stats submission - skipping here to prevent double XP`);

      // Send confirmation notification to the captain who just confirmed
      try {
        await notifyCaptainConfirmed(match, userId);
      } catch (notifErr) {
        console.error('Failed to send confirmation notification:', notifErr);
      }

      // Check if this match completion triggers season/league completion
      try {
        const completionResult = await checkAndCompleteLeagueAfterMatch(matchId);
        if (completionResult.seasonCompleted) {
          console.log(`🏆 Season completed after match ${matchId}!`);
        }
        if (completionResult.leagueCompleted) {
          console.log(`🏆🏆 League completed after match ${matchId}! League marked as inactive.`);
        }
      } catch (completionErr) {
        console.error('Failed to check league completion:', completionErr);
      }
    }

    ctx.body = {
      success: true,
      message: bothConfirmed ? 'Result confirmed by both captains' : 'Result confirmed',
      confirmed: true,
      bothConfirmed,
      match: {
        id: match.id,
        status: match.status,
        homeCaptainConfirmed: match.homeCaptainConfirmed,
        awayCaptainConfirmed: match.awayCaptainConfirmed
      }
    };
  } catch (err) {
    console.error('Confirm result error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to confirm result' };
  }
};

// Get stats window for match
export const getStatsWindow = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const statsWindow = await MatchStatistics.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position'] }]
    });

    ctx.body = {
      success: true,
      stats: statsWindow.map(s => ({
        userId: s.user_id,
        goals: s.goals,
        assists: s.assists,
        cleanSheets: s.cleanSheets,
        user: (s as any).user
      }))
    };
  } catch (err) {
    console.error('Get stats window error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch stats' };
  }
};

// Submit match stats
export const submitMatchStats = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const body = ctx.request.body as any;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  // Handle both single stats object and array of stats
  // Frontend sends single object: { playerId?, goals, assists, ... }
  // Or array: [{ playerId, goals, assists, ... }]
  let statsArray: Array<any>;
  
  if (Array.isArray(body.stats)) {
    // Legacy format: { stats: [...] }
    statsArray = body.stats;
  } else if (Array.isArray(body)) {
    // Array format: [...]
    statsArray = body;
  } else if (body.playerId || body.goals !== undefined) {
    // Single object format: { playerId, goals, assists, ... }
    // If no playerId, it's the current user submitting their own stats
    statsArray = [body];
  } else {
    ctx.throw(400, 'Invalid stats format');
    return;
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    // Check if the league is locked (completed for more than 24 hours)
    if (match.leagueId) {
      const lockStatus = await isLeagueLocked(match.leagueId);
      if (lockStatus.locked) {
        ctx.throw(403, 'This league has been completed for over 24 hours. Points are now locked and stats cannot be updated.');
        return;
      }
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    
    // Allow both admins and players to submit their own stats
    const currentUserId = String(ctx.state.user.userId);
    
    console.log(`📊 Stats submission - Request body:`, JSON.stringify(statsArray, null, 2));
    
    for (const stat of statsArray) {
      // Determine target user: if playerId provided, use it; otherwise use current user
      const targetPlayerId = stat.playerId || currentUserId;
      const userId = await resolveTargetUserIdForMatch(targetPlayerId, matchId);
      const safeGoals = Math.max(0, Number(stat.goals) || 0);
      const safeAssists = Math.max(0, Number(stat.assists) || 0);
      const safeCleanSheets = Math.max(0, Number(stat.cleanSheets || stat.cleanSheet) || 0);
      const safePenalties = Math.max(0, Number(stat.penalties) || 0);
      const safeFreeKicks = Math.max(0, Number(stat.freeKicks) || 0);
      const safeDefence = Math.max(0, Number(stat.defence) || 0);
      
      console.log(`📊 Processing stats for user ${userId}:`, {
        goals: stat.goals,
        assists: stat.assists,
        cleanSheets: stat.cleanSheets || stat.cleanSheet,
        defence: stat.defence,
        impact: stat.impact
      });
      
      // Check permissions: admins can edit anyone, players can only edit themselves
      if (!isAdmin && userId !== currentUserId) {
        ctx.throw(403, 'You can only submit your own stats');
        return;
      }

      const homeGoalsForImpact = match.homeTeamGoals ?? 0;
      const awayGoalsForImpact = match.awayTeamGoals ?? 0;
      const homeTeamUserIdsForImpact = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );
      const awayTeamUserIdsForImpact = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );
      const isHomeForImpact = homeTeamUserIdsForImpact.some(u => String(u.userId) === String(userId));
      const isAwayForImpact = awayTeamUserIdsForImpact.some(u => String(u.userId) === String(userId));
      const teamGoalsForImpact = isHomeForImpact
        ? homeGoalsForImpact
        : isAwayForImpact
          ? awayGoalsForImpact
          : Math.max(homeGoalsForImpact, awayGoalsForImpact, 0);
      const captainPicksForImpact = await sequelize.query(
        `SELECT "homeMentalityId", "awayMentalityId" FROM "Matches" WHERE id = $1`,
        { bind: [matchId], type: QueryTypes.SELECT }
      );
      const picksForImpact = (captainPicksForImpact[0] as any) || {};
      const isMentalityPickForImpact =
        (picksForImpact.homeMentalityId && String(picksForImpact.homeMentalityId) === String(userId)) ||
        (picksForImpact.awayMentalityId && String(picksForImpact.awayMentalityId) === String(userId));

      // Client-shared Match Contribution Index formula
      // Goal baseline = 100%, Assist = 50%, CleanSheet = 15%, DefensiveImpact = 10%, Mentality = 5%
      const goalContribution = teamGoalsForImpact > 0 ? (safeGoals / teamGoalsForImpact) * 100 : 0;
      const assistContribution = teamGoalsForImpact > 0 ? (safeAssists / teamGoalsForImpact) * 50 : 0;
      const cleanSheetContribution = safeCleanSheets > 0 ? 15 * safeCleanSheets : 0;
      const defensiveContribution = safeDefence * 10;
      const mentalityContribution = isMentalityPickForImpact ? 5 : 0;
      const rawContribution =
        goalContribution +
        assistContribution +
        cleanSheetContribution +
        defensiveContribution +
        mentalityContribution;

      // Participation floor if no contribution action is recorded
      const computedImpact = clampPercentage(rawContribution > 0 ? rawContribution : 15);
      
      const [statRecord, created] = await MatchStatistics.findOrCreate({
        where: { match_id: matchId, user_id: userId },
        defaults: {
          match_id: matchId,
          user_id: userId,
          goals: safeGoals,
          assists: safeAssists,
          cleanSheets: safeCleanSheets,
          penalties: safePenalties,
          freeKicks: safeFreeKicks,
          yellowCards: stat.yellowCards || 0,
          redCards: stat.redCards || 0,
          defence: safeDefence,
          impact: computedImpact,
          minutesPlayed: stat.minutesPlayed || 0,
          rating: stat.rating || 0,
          xpAwarded: 0
        }
      });

      console.log(`📊 Stats record ${created ? 'CREATED' : 'FOUND'} for user ${userId}`);

      const updateData = {
        goals: safeGoals,
        assists: safeAssists,
        cleanSheets: safeCleanSheets,
        penalties: safePenalties,
        freeKicks: safeFreeKicks,
        defence: safeDefence,
        impact: computedImpact
      };
      
      console.log(`📊 Updating stats for user ${userId}:`, updateData);
      
      await statRecord.update(updateData);
      
      // Verify stats were saved correctly
      const verifyStats = await MatchStatistics.findOne({
        where: { match_id: matchId, user_id: userId }
      });
      console.log(`✅ Stats VERIFIED in DB for user ${userId}:`, {
        match_id: verifyStats?.match_id,
        user_id: verifyStats?.user_id,
        goals: verifyStats?.goals,
        assists: verifyStats?.assists,
        cleanSheets: verifyStats?.cleanSheets
      });

      // 🎮 IMMEDIATELY AWARD XP when stats are submitted (or UPDATE if stats changed)
      try {
        const homeTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
          { replacements: { matchId }, type: QueryTypes.SELECT }
        );
        const awayTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
          { replacements: { matchId }, type: QueryTypes.SELECT }
        );
        
        const isHome = homeTeamUserIds.some(u => String(u.userId) === String(userId));
        const isAway = awayTeamUserIds.some(u => String(u.userId) === String(userId));
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        
        let teamResult: 'win' | 'draw' | 'lose' = 'lose';
        if (isHome && homeGoals > awayGoals) teamResult = 'win';
        else if (isAway && awayGoals > homeGoals) teamResult = 'win';
        else if (homeGoals === awayGoals) teamResult = 'draw';
        
        let newXpToAward = 0;
        const breakdown: string[] = [];
        
        // Win/Draw/Loss
        if (teamResult === 'win') {
          newXpToAward += xpPointsTable.winningTeam;
          breakdown.push(`Win: +${xpPointsTable.winningTeam}`);
        } else if (teamResult === 'draw') {
          newXpToAward += xpPointsTable.draw;
          breakdown.push(`Draw: +${xpPointsTable.draw}`);
        } else {
          newXpToAward += xpPointsTable.losingTeam;
          breakdown.push(`Loss: +${xpPointsTable.losingTeam}`);
        }
        
        // Goals
        if (safeGoals > 0) {
          const goalXP = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * safeGoals;
          newXpToAward += goalXP;
          breakdown.push(`Goals (${safeGoals}): +${goalXP}`);
        }
        
        // Assists
        if (safeAssists > 0) {
          const assistXP = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * safeAssists;
          newXpToAward += assistXP;
          breakdown.push(`Assists (${safeAssists}): +${assistXP}`);
        }
        
        // Clean Sheets
        const cleanSheets = safeCleanSheets;
        if (cleanSheets > 0) {
          const cleanSheetXP = xpPointsTable.cleanSheet * cleanSheets;
          newXpToAward += cleanSheetXP;
          breakdown.push(`Clean Sheets (${cleanSheets}): +${cleanSheetXP}`);
        }
        
        // � MOTM (Man of the Match) XP - Check votes received by this user
        try {
          // Get all votes for this match where this user was voted for
          const votesResult = await sequelize.query(
            `SELECT COUNT(DISTINCT "voterId") as vote_count FROM "Votes" WHERE "matchId" = $1 AND "votedForId" = $2`,
            { bind: [matchId, userId], type: QueryTypes.SELECT }
          );
          
          const voteCount = parseInt((votesResult[0] as any)?.vote_count || '0', 10);
          
          if (voteCount > 0) {
            // Individual vote XP (motmVote) - XP for each vote received
            const voteXP = (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCount;
            newXpToAward += voteXP;
            breakdown.push(`MOTM Votes (${voteCount}): +${voteXP}`);
            console.log(`🗳️ User ${userId} received ${voteCount} MOTM votes - +${voteXP} XP`);
            
            // Check if this user has the MOST votes (is the actual MOTM winner)
            const mostVotesResult = await sequelize.query(
              `SELECT "votedForId", COUNT(DISTINCT "voterId") as vote_count 
               FROM "Votes" 
               WHERE "matchId" = $1 
               GROUP BY "votedForId" 
               ORDER BY vote_count DESC 
               LIMIT 1`,
              { bind: [matchId], type: QueryTypes.SELECT }
            );

            const top = (mostVotesResult[0] as any) || null;
            const topVotedForId = top?.votedForId ? String(top.votedForId) : '';
            if (topVotedForId && topVotedForId === String(userId)) {
              const motmWinnerXP = teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose;
              newXpToAward += motmWinnerXP;
              breakdown.push(`MOTM Winner: +${motmWinnerXP}`);
            }
          }
        } catch (motmErr) {
          console.error('⚠️ Error checking MOTM votes:', motmErr);
        }
        
        // �🏆 CAPTAIN PICKS XP - Check if this user was selected for captain picks
        try {
          // Get captain picks for this match (both home and away teams)
          // Table name is "Matches" (with capital M) in database
          const captainPicksResult = await sequelize.query(
            `SELECT "homeDefensiveImpactId", "awayDefensiveImpactId", "homeMentalityId", "awayMentalityId" FROM "Matches" WHERE id = $1`,
            { bind: [matchId], type: QueryTypes.SELECT }
          );
          
          if (captainPicksResult.length > 0) {
            const picks = captainPicksResult[0] as any;
            console.log(`🏆 Captain Picks for match ${matchId}:`, JSON.stringify(picks));
            
            // Defensive Impact XP - check both home and away picks
            const isDefensivePick = 
              (picks.homeDefensiveImpactId && String(picks.homeDefensiveImpactId) === String(userId)) ||
              (picks.awayDefensiveImpactId && String(picks.awayDefensiveImpactId) === String(userId));
            
            if (isDefensivePick) {
              const defenseXP = teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
              newXpToAward += defenseXP;
              breakdown.push(`Defensive Impact (Captain Pick): +${defenseXP}`);
              console.log(`🛡️ User ${userId} selected for Defensive Impact - +${defenseXP} XP`);
            }
            
            // Mentality XP - check both home and away picks
            const isMentalityPick = 
              (picks.homeMentalityId && String(picks.homeMentalityId) === String(userId)) ||
              (picks.awayMentalityId && String(picks.awayMentalityId) === String(userId));
            
            if (isMentalityPick) {
              const mentalityXP = teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
              newXpToAward += mentalityXP;
              breakdown.push(`Mentality (Captain Pick): +${mentalityXP}`);
              console.log(`💪 User ${userId} selected for Mentality - +${mentalityXP} XP`);
            }
          }
        } catch (captainErr) {
          console.error('⚠️ Error checking captain picks:', captainErr);
        }
        
        console.log(`🎮 XP CALCULATION for user ${userId}:`);
        console.log(`   Team Result: ${teamResult.toUpperCase()}`);
        console.log(`   Breakdown: ${breakdown.join(', ')}`);
        console.log(`   New XP to award: +${newXpToAward}`);
        
        // 💰 CHECK IF XP WAS ALREADY AWARDED (for stat updates)
        // Table name is "match_statistics" (snake_case) in database
        console.log(`🔍 Checking existing XP for matchId=${matchId}, userId=${userId}`);
        
        const existingXPResult = await sequelize.query(
          `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
          { bind: [matchId, userId], type: QueryTypes.SELECT }
        );
        
        console.log(`🔍 Existing XP Query Result:`, JSON.stringify(existingXPResult));
        
        const previouslyAwardedXP = (existingXPResult[0] as any)?.xp_awarded || 0;
        const xpDifference = newXpToAward - previouslyAwardedXP;
        
        console.log(`📊 XP UPDATE CHECK:`);
        console.log(`   Previously awarded XP: ${previouslyAwardedXP}`);
        console.log(`   New XP to award: ${newXpToAward}`);
        console.log(`   Difference (to add/subtract): ${xpDifference > 0 ? '+' : ''}${xpDifference}`);
        
        // Get current user XP
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [userId], type: QueryTypes.SELECT }
        );
        
        console.log(`🔍 User Query Result:`, JSON.stringify(userResult));
        
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const currentXP = user.xp || 0;
          const finalXP = Math.max(0, currentXP + xpDifference); // Ensure XP doesn't go negative
          
          console.log(`📝 Updating user XP: ${currentXP} + (${xpDifference}) = ${finalXP}`);
          
          // Update user XP using raw SQL (add or subtract the difference)
          const updateUserResult = await sequelize.query(
            `UPDATE users SET xp = $1 WHERE id = $2 RETURNING xp`,
            { bind: [finalXP, userId], type: QueryTypes.UPDATE }
          );
          console.log(`📝 User XP Update Result:`, JSON.stringify(updateUserResult));
          
          // Update match_statistics with new xp_awarded value
          const updateStatsResult = await sequelize.query(
            `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3 RETURNING xp_awarded`,
            { bind: [newXpToAward, matchId, userId], type: QueryTypes.UPDATE }
          );
          console.log(`📝 match_statistics Update Result:`, JSON.stringify(updateStatsResult));
          
          if (xpDifference > 0) {
            console.log(`💰 XP ADDED! User ${userId} (${user.firstName}): +${xpDifference} XP`);
          } else if (xpDifference < 0) {
            console.log(`📉 XP REDUCED! User ${userId} (${user.firstName}): ${xpDifference} XP`);
          } else {
            console.log(`⚖️ XP UNCHANGED! User ${userId} (${user.firstName}): No change`);
          }
          console.log(`   Total XP: ${currentXP} → ${finalXP}`);
          
          // Verify both tables
          const verifyUser = await sequelize.query(
            `SELECT xp FROM users WHERE id = $1`,
            { bind: [userId], type: QueryTypes.SELECT }
          );
          const verifyStats = await sequelize.query(
            `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
            { bind: [matchId, userId], type: QueryTypes.SELECT }
          );
          console.log(`   ✅ VERIFIED - users.xp: ${(verifyUser[0] as any)?.xp}`);
          console.log(`   ✅ VERIFIED - match_statistics.xp_awarded: ${(verifyStats[0] as any)?.xp_awarded}`);
        } else {
          console.log(`❌ User not found with id: ${userId}`);
        }
      } catch (xpErr: any) {
        console.error('⚠️ Could not award XP - FULL ERROR:', xpErr);
        console.error('⚠️ Error message:', xpErr?.message);
        console.error('⚠️ Error stack:', xpErr?.stack);
      }

      console.log(`🏁 XP Processing complete for user ${userId}`);

      // Update cache
      try {
        cache.updateLeaderboard(`leaderboard_goals_${match.leagueId}_all`, { playerId: userId, value: safeGoals });
        cache.updateLeaderboard(`leaderboard_assists_${match.leagueId}_all`, { playerId: userId, value: safeAssists });
        if (safeCleanSheets > 0) {
          cache.updateLeaderboard(`leaderboard_cleanSheet_${match.leagueId}_all`, { playerId: userId, value: 1 });
        }
      } catch {}
    }

    try {
      await recalculateMatchXPForCurrentState(matchId);
    } catch (recalcErr) {
      console.error('Could not recalculate match XP after stats submission:', recalcErr);
    }

    console.log(`✅ Stats submission complete - sending response`);
    
    // After stats submitted, re-check if league is now complete
    // (completion requires last 2 matches to have all players' stats)
    try {
      const completionResult = await checkAndCompleteLeagueAfterMatch(matchId);
      if (completionResult.leagueCompleted) {
        console.log(`🏆 League completed after stats submission for match ${matchId}!`);
      }
    } catch (completionErr) {
      console.error('Failed to check league completion after stats:', completionErr);
    }

    ctx.body = { success: true, message: 'Stats submitted successfully' };
  } catch (err) {
    console.error('Submit stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit stats' };
  }
};

// Get match votes
export const getMatchVotes = async (ctx: Context) => {
  const { id: matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId || ctx.state.user.id;
  const cacheKey = `match_votes_${matchId}_${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  try {
    // Get all votes grouped by votedForId
    const votes = await Vote.findAll({
      where: { matchId },
      attributes: ['votedForId', [fn('COUNT', fn('DISTINCT', col('voterId'))), 'count']],
      group: ['votedForId']
    });

    // Convert to object format { playerId: count }
    const votesObject: Record<string, number> = {};
    votes.forEach((v: any) => {
      votesObject[v.votedForId] = Number(v.get('count'));
    });

    // Add guest display aliases: guest-<guestId> -> same count as guest mirror user id.
    const { mirrorToDisplay } = await getMatchGuestMirrorMaps(matchId);
    mirrorToDisplay.forEach((displayId, mirrorUserId) => {
      if (typeof votesObject[mirrorUserId] === 'number') {
        votesObject[displayId] = votesObject[mirrorUserId];
      }
    });

    // Get current user's vote
    const userVote = await Vote.findOne({
      where: { matchId, voterId: userId },
      attributes: ['votedForId']
    });

    const rawUserVote = userVote?.votedForId ? String(userVote.votedForId) : null;
    const userVoteDisplay = rawUserVote ? (mirrorToDisplay.get(rawUserVote) || rawUserVote) : null;

    const result = {
      success: true,
      votes: votesObject,
      userVote: userVoteDisplay
    };

    cache.set(cacheKey, result, 60); // Cache for 1 minute
    ctx.body = result;
  } catch (err) {
    console.error('Get votes error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch votes' };
  }
};

// Get match by ID
export const getMatchById = async (ctx: Context) => {
  const { matchId } = ctx.params;

  try {
    console.log('🔍 Fetching match with ID:', matchId);
    
    const match = await Match.findByPk(matchId, {
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] },
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] }
      ]
    });

    console.log('🔍 Match query result:', match ? 'Found' : 'Not found');

    if (!match) {
      console.log('❌ Match not found in database');
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        date: match.date,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        status: match.status,
        league: (match as any).league,
        homeTeamUsers: (match as any).homeTeamUsers,
        awayTeamUsers: (match as any).awayTeamUsers
      }
    };
  } catch (err) {
    console.error('❌ Get match error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch match', error: err instanceof Error ? err.message : String(err) };
  }
};

// Get all matches
export const getAllMatches = async (ctx: Context) => {
  try {
    const matches = await Match.findAll({
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] }
      ],
      order: [['date', 'DESC']]
    });

    ctx.body = {
      success: true,
      matches: matches.map(m => ({
        id: m.id,
        date: m.date,
        status: m.status,
        homeTeamGoals: m.homeTeamGoals,
        awayTeamGoals: m.awayTeamGoals,
        league: (m as any).league
      }))
    };
  } catch (err) {
    console.error('Get all matches error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch matches' };
  }
};

// Get match stats
export const getMatchStats = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { playerId } = ctx.query as { playerId?: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    // If playerId is provided, get stats for that specific player only
    if (playerId) {
      let targetUserId = String(playerId);
      // Support guest IDs from UI (guest-<guestId> or raw guestId)
      try {
        targetUserId = await resolveTargetUserIdForMatch(targetUserId, matchId);
      } catch {
        // keep original if resolution fails; query below may still find a direct user stat
        targetUserId = String(playerId);
      }

      const teamForTarget = await getPlayerTeamForMatch(targetUserId, matchId);
      if (!teamForTarget) {
        ctx.body = { success: true, stats: null };
        return;
      }

      const stat = await MatchStatistics.findOne({
        where: { match_id: matchId, user_id: targetUserId },
        include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'provider', 'providerId'] }]
      });

      if (stat) {
        const statUser = (stat as any).user as any;
        const isGuestMirror =
          String(statUser?.provider || '') === 'guest' &&
          String(statUser?.providerId || '').trim() !== '';
        const displayUserId = isGuestMirror
          ? `guest-${String(statUser.providerId)}`
          : String(stat.user_id);

        ctx.body = {
          success: true,
          stats: {
            userId: stat.user_id,
            displayUserId,
            goals: stat.goals,
            assists: stat.assists,
            cleanSheets: stat.cleanSheets,
            penalties: stat.penalties,
            freeKicks: stat.freeKicks,
            defence: stat.defence,
            impact: stat.impact,
            impactPercent: `${Number(stat.impact) || 0}%`,
            xpAwarded: (stat as any).xpAwarded || 0,
            user: statUser
              ? {
                  id: statUser.id,
                  firstName: statUser.firstName,
                  lastName: statUser.lastName,
                  profilePicture: statUser.profilePicture
                }
              : null
          }
        };
      } else {
        ctx.body = {
          success: true,
          stats: null
        };
      }
      return;
    }

    // Otherwise, get all stats for the match
    const stats = await MatchStatistics.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'provider', 'providerId'] }]
    });

    ctx.body = {
      success: true,
      stats: stats.map(s => {
        const statUser = (s as any).user as any;
        const isGuestMirror =
          String(statUser?.provider || '') === 'guest' &&
          String(statUser?.providerId || '').trim() !== '';
        const displayUserId = isGuestMirror
          ? `guest-${String(statUser.providerId)}`
          : String(s.user_id);

        return {
          userId: s.user_id,
          displayUserId,
          goals: s.goals,
          assists: s.assists,
          cleanSheets: s.cleanSheets,
          penalties: s.penalties,
          freeKicks: s.freeKicks,
          defence: s.defence,
          impact: s.impact,
          impactPercent: `${Number(s.impact) || 0}%`,
          xpAwarded: (s as any).xpAwarded || 0,
          user: statUser
            ? {
                id: statUser.id,
                firstName: statUser.firstName,
                lastName: statUser.lastName,
                profilePicture: statUser.profilePicture
              }
            : null
        };
      })
    };
  } catch (err) {
    console.error('Get match stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch stats' };
  }
};

// Get match availability
export const getMatchAvailability = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const availability = await MatchAvailability.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'userRecord', attributes: ['id', 'firstName', 'lastName', 'profilePicture'] }]
    });

    const availableOrderedUserIds = availability
      .filter(a => a.status === 'available')
      .sort((a, b) => {
        const aTime = new Date(((a as any).created_at ?? (a as any).createdAt ?? 0)).getTime();
        const bTime = new Date(((b as any).created_at ?? (b as any).createdAt ?? 0)).getTime();
        return aTime - bTime;
      })
      .map(a => String(a.user_id));

    const availableOrderMap: Record<string, number> = {};
    availableOrderedUserIds.forEach((uid, idx) => {
      availableOrderMap[uid] = idx + 1;
    });

    ctx.body = {
      success: true,
      availability: availability.map(a => ({
        userId: a.user_id,
        available: a.status === 'available',
        acceptedAt: (a as any).created_at ?? (a as any).createdAt ?? null,
        user: (a as any).userRecord
      })),
      // Also return just the available user IDs for simpler client consumption
      availableUserIds: availability
        .filter(a => a.status === 'available')
        .map(a => a.user_id),
      // Ordered by acceptance timestamp (first accepted = 1)
      availableOrderedUserIds,
      availableOrderMap
    };
  } catch (err) {
    console.error('Get availability error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch availability' };
  }
};

// Update match
export const updateMatch = async (ctx: Context) => {
  const { id } = ctx.params;
  const { date, status, homeTeamGoals, awayTeamGoals, archived } = ctx.request.body as any;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(id, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update matches');
      return;
    }

    const updateData: any = {};
    if (date) updateData.date = new Date(date);
    if (status) updateData.status = status;
    if (typeof homeTeamGoals === 'number') updateData.homeTeamGoals = homeTeamGoals;
    if (typeof awayTeamGoals === 'number') updateData.awayTeamGoals = awayTeamGoals;
    if (typeof archived === 'boolean') updateData.archived = archived;

    const includesScoreUpdate = typeof homeTeamGoals === 'number' || typeof awayTeamGoals === 'number';
    if (includesScoreUpdate) {
      const { registeredPlayers, totalPlayers } = await getMatchPlayerCounts(id);
      const validationMessage = getScoreUploadValidationMessage(registeredPlayers, totalPlayers);
      if (validationMessage) {
        ctx.status = 400;
        ctx.body = { success: false, message: validationMessage };
        return;
      }
    }

    await match.update(updateData);

    if (includesScoreUpdate) {
      try {
        await recalculateMatchXPForCurrentState(id);
      } catch (recalcErr) {
        console.error('Could not recalculate match XP after match edit score change:', recalcErr);
      }
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        date: match.date,
        status: match.status,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        archived: match.archived
      }
    };
  } catch (err) {
    console.error('Update match error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update match' };
  }
};

// Delete match
export const deleteMatch = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(id, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can delete matches');
      return;
    }

    await match.destroy();

    ctx.body = {
      success: true,
      message: 'Match deleted successfully'
    };
  } catch (err) {
    console.error('Delete match error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to delete match' };
  }
};

// Check if match has stats
export const hasMatchStats = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const count = await MatchStatistics.count({ where: { match_id: id } });
    
    ctx.body = {
      success: true,
      hasStats: count > 0,
      count
    };
  } catch (err) {
    console.error('Check stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to check stats' };
  }
};

// Get captain picks
export const getCaptainPicks = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const cacheKey = `captain_picks_${matchId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    const { mirrorToDisplay } = await getMatchGuestMirrorMaps(matchId);
    const toDisplay = (id?: string | null) => {
      if (!id) return null;
      const sid = String(id);
      return mirrorToDisplay.get(sid) || sid;
    };

    const result = {
      success: true,
      home: {
        defence: toDisplay(match.homeDefensiveImpactId),
        influence: toDisplay(match.homeMentalityId)
      },
      away: {
        defence: toDisplay(match.awayDefensiveImpactId),
        influence: toDisplay(match.awayMentalityId)
      }
    };

    cache.set(cacheKey, result, 300);
    ctx.body = result;
  } catch (err) {
    console.error('Get captain picks error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch captain picks' };
  }
};

// Submit captain picks (Defensive Impact and Mentality)
export const submitCaptainPicks = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { category, playerId } = ctx.request.body as { category: 'defence' | 'influence'; playerId: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId || ctx.state.user.id;

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    // Check if user is a captain
    const isHomeCaptain = String(match.homeCaptainId || '') === String(userId);
    const isAwayCaptain = String(match.awayCaptainId || '') === String(userId);

    if (!isHomeCaptain && !isAwayCaptain) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only team captains can save picks' };
      return;
    }

    if (category !== 'defence' && category !== 'influence') {
      ctx.status = 400;
      ctx.body = { success: false, message: 'Invalid captain pick category' };
      return;
    }

    let targetUserId: string;
    try {
      targetUserId = await resolveTargetUserIdForMatch(String(playerId), matchId);
    } catch {
      ctx.status = 400;
      ctx.body = { success: false, message: 'Selected player is invalid for this match' };
      return;
    }

    if (String(targetUserId) === String(userId)) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'You cannot select yourself as a captain bonus pick' };
      return;
    }

    const captainTeam: 'home' | 'away' = isHomeCaptain ? 'home' : 'away';
    const targetTeam = await getPlayerTeamForMatch(targetUserId, matchId);
    if (!targetTeam) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'Selected player is not part of this match' };
      return;
    }
    if (targetTeam !== captainTeam) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'You can only pick players from your own team' };
      return;
    }

    // Update appropriate field based on team and category
    if (isHomeCaptain) {
      if (category === 'defence') {
        await match.update({ homeDefensiveImpactId: targetUserId });
      } else if (category === 'influence') {
        await match.update({ homeMentalityId: targetUserId });
      }
    } else if (isAwayCaptain) {
      if (category === 'defence') {
        await match.update({ awayDefensiveImpactId: targetUserId });
      } else if (category === 'influence') {
        await match.update({ awayMentalityId: targetUserId });
      }
    }

    // Clear cache
    cache.del(`captain_picks_${matchId}`);
    cache.del(`match_${matchId}`);

    ctx.body = {
      success: true,
      message: 'Captain pick saved'
    };
  } catch (err) {
    console.error('Submit captain pick error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit captain pick' };
  }
};

// Get match prediction — team strength analysis based on player XP
export const getMatchPrediction = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    // Load match with team players
    const match = await Match.findByPk(matchId, {
      include: [
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'xp'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'xp'] },
      ],
    });

    if (!match) {
      ctx.body = { success: true, available: false, reason: 'MATCH_NOT_FOUND' };
      return;
    }

    const homePlayers: any[] = (match as any).homeTeamUsers || [];
    const awayPlayers: any[] = (match as any).awayTeamUsers || [];

    // Match number within the league
    let matchNumber: number | null = null;
    if (match.leagueId) {
      const leagueMatches = await Match.findAll({
        where: { leagueId: match.leagueId },
        attributes: ['id'],
        order: [['createdAt', 'ASC']],
      });
      const idx = leagueMatches.findIndex((m: any) => String(m.id) === String(matchId));
      if (idx >= 0) matchNumber = idx + 1;
    }

    // Need at least 1 player on each side
    if (homePlayers.length === 0 || awayPlayers.length === 0) {
      ctx.body = {
        success: true,
        available: false,
        matchNumber,
        reason: 'NO_SELECTED_PLAYERS',
      };
      return;
    }

    // Compute XP sums and averages
    const homeXpSum = homePlayers.reduce((s: number, p: any) => s + (Number(p.xp) || 0), 0);
    const awayXpSum = awayPlayers.reduce((s: number, p: any) => s + (Number(p.xp) || 0), 0);
    const homeAvg = homePlayers.length > 0 ? homeXpSum / homePlayers.length : 0;
    const awayAvg = awayPlayers.length > 0 ? awayXpSum / awayPlayers.length : 0;
    const totalAvg = homeAvg + awayAvg;

    // If both teams have 0 XP total, not enough data
    if (totalAvg === 0) {
      ctx.body = {
        success: true,
        available: false,
        matchNumber,
        reason: 'FIRST_MATCH_NO_STATS',
      };
      return;
    }

    // Home win %, clamped between 20-80 to avoid extreme predictions
    const rawHomePct = (homeAvg / totalAvg) * 100;
    const matchupPct = Math.round(Math.max(20, Math.min(80, rawHomePct)));

    // Determine predicted winner
    const diff = homeAvg - awayAvg;
    const drawThreshold = totalAvg * 0.05; // within 5% is a draw
    let predicted: 'home' | 'away' | 'draw';
    if (Math.abs(diff) < drawThreshold) {
      predicted = 'draw';
    } else if (diff > 0) {
      predicted = 'home';
    } else {
      predicted = 'away';
    }

    // Generate predicted score based on strength ratio
    // Base goals ~ 1-4, scaled by team player count and XP ratio
    const playerCountFactor = Math.min(homePlayers.length, awayPlayers.length);
    const baseGoals = Math.max(1, Math.min(4, Math.round(playerCountFactor / 3)));
    const ratio = totalAvg > 0 ? homeAvg / totalAvg : 0.5;

    let homeGoals: number;
    let awayGoals: number;
    if (predicted === 'draw') {
      homeGoals = baseGoals;
      awayGoals = baseGoals;
    } else {
      const strongerGoals = baseGoals + Math.round(Math.abs(ratio - 0.5) * 4);
      const weakerGoals = Math.max(0, baseGoals - Math.round(Math.abs(ratio - 0.5) * 3));
      if (predicted === 'home') {
        homeGoals = strongerGoals;
        awayGoals = weakerGoals;
      } else {
        homeGoals = weakerGoals;
        awayGoals = strongerGoals;
      }
    }

    const predictedScore = `${homeGoals} - ${awayGoals}`;

    ctx.body = {
      success: true,
      available: true,
      matchNumber,
      home: { average: Math.round(homeAvg), total: homeXpSum, count: homePlayers.length },
      away: { average: Math.round(awayAvg), total: awayXpSum, count: awayPlayers.length },
      matchupPct,
      predicted,
      predictedScore,
    };
  } catch (err) {
    console.error('Get prediction error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch prediction' };
  }
};

// Submit match prediction (supports both goal predictions and team strength analysis)
export const submitMatchPrediction = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const body = ctx.request.body as { 
    homeGoals?: number | string; 
    awayGoals?: number | string;
    homeIds?: string[];
    awayIds?: string[];
    homeTotal?: number;
    awayTotal?: number;
  };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;

  // Check if this is a team strength analysis request (homeIds/awayIds provided)
  if (body.homeIds !== undefined || body.awayIds !== undefined) {
    try {
      const homeIds = body.homeIds || [];
      const awayIds = body.awayIds || [];
      const homeTotal = body.homeTotal || homeIds.length;
      const awayTotal = body.awayTotal || awayIds.length;

      // Calculate team strength based on player XP/stats
      let homeXPSum = 0;
      let awayXPSum = 0;

      // Fetch XP for home team players
      if (homeIds.length > 0) {
        const homePlayers = await User.findAll({
          where: { id: { [Op.in]: homeIds } },
          attributes: ['id', 'xp']
        });
        homeXPSum = homePlayers.reduce((sum: number, p: any) => sum + (p.xp || 0), 0);
      }

      // Fetch XP for away team players
      if (awayIds.length > 0) {
        const awayPlayers = await User.findAll({
          where: { id: { [Op.in]: awayIds } },
          attributes: ['id', 'xp']
        });
        awayXPSum = awayPlayers.reduce((sum: number, p: any) => sum + (p.xp || 0), 0);
      }

      // Calculate averages
      const homeAvg = homeTotal > 0 ? homeXPSum / homeTotal : 0;
      const awayAvg = awayTotal > 0 ? awayXPSum / awayTotal : 0;

      // Calculate win percentages
      const total = homeAvg + awayAvg;
      const homeWinPct = total > 0 ? Math.round((homeAvg / total) * 100) : 50;
      const awayWinPct = total > 0 ? Math.round((awayAvg / total) * 100) : 50;

      ctx.body = {
        success: true,
        home: {
          average: homeAvg,
          winPct: homeWinPct
        },
        away: {
          average: awayAvg,
          winPct: awayWinPct
        }
      };
      return;
    } catch (err) {
      console.error('Team strength analysis error:', err);
      ctx.status = 500;
      ctx.body = { success: false, message: 'Failed to calculate team strength' };
      return;
    }
  }
  
  // Otherwise, handle goal prediction
  const homeGoals = typeof body.homeGoals === 'number' ? body.homeGoals : parseInt(String(body.homeGoals), 10);
  const awayGoals = typeof body.awayGoals === 'number' ? body.awayGoals : parseInt(String(body.awayGoals), 10);

  if (isNaN(homeGoals) || isNaN(awayGoals)) {
    ctx.throw(400, 'homeGoals and awayGoals must be valid numbers');
    return;
  }

  try {
    const MatchPrediction = (models as any).MatchPrediction;
    if (!MatchPrediction) {
      ctx.throw(404, 'MatchPrediction model not found');
      return;
    }
    const [prediction, created] = await MatchPrediction.findOrCreate({
      where: { matchId, userId },
      defaults: { matchId, userId, homeGoals, awayGoals, correct: false }
    });

    if (!created) {
      await prediction.update({ homeGoals, awayGoals });
    }

    ctx.body = {
      success: true,
      message: 'Prediction submitted',
      prediction: { homeGoals, awayGoals }
    };
  } catch (err) {
    console.error('Submit prediction error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit prediction' };
  }
};

// ============================================================================
// DEBUG: Get XP breakdown for a match - shows who got what XP and why
// ============================================================================
export const getMatchXPBreakdown = async (ctx: Context) => {
  const { matchId } = ctx.params;
  
  console.log('📊 [XP DEBUG] Getting XP breakdown for match:', matchId);
  
  try {
    // 1. Get match details
    const match = await sequelize.query(`
      SELECT m.id, m."homeTeamGoals", m."awayTeamGoals", m.status,
             m."homeCaptainId", m."awayCaptainId",
             m."homeDefensiveImpactId", m."awayDefensiveImpactId",
             m."homeMentalityId", m."awayMentalityId",
             m."homeTeamName", m."awayTeamName"
      FROM "Matches" m
      WHERE m.id = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    if (!match || match.length === 0) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }
    
    const matchData = match[0] as any;
    console.log('📊 [XP DEBUG] Match data:', matchData);
    
    // 2. Determine match result
    const homeGoals = matchData.homeTeamGoals || 0;
    const awayGoals = matchData.awayTeamGoals || 0;
    let matchResult = 'draw';
    if (homeGoals > awayGoals) matchResult = 'home_win';
    else if (awayGoals > homeGoals) matchResult = 'away_win';
    
    // 3. Get all match statistics for this match
    const stats = await sequelize.query(`
      SELECT
        ms.id,
        ms.user_id AS "userId",
        ms.match_id AS "matchId",
        COALESCE(ms.goals, 0) AS goals,
        COALESCE(ms.assists, 0) AS assists,
        COALESCE(ms.clean_sheets, 0) AS "cleanSheets",
        COALESCE(ms.penalties, 0) AS penalties,
        COALESCE(ms.free_kicks, 0) AS "freeKicks",
        COALESCE(ms.defence, 0) AS defence,
        COALESCE(ms.impact, 0) AS impact,
        COALESCE(ms.xp_awarded, 0) AS "xp_awarded",
        COALESCE(ms.xp_awarded, 0) AS "xpAwarded",
        u."firstName",
        u."lastName",
        COALESCE(u.xp, 0) AS "currentUserXP"
      FROM match_statistics ms
      JOIN users u ON ms.user_id = u.id
      WHERE ms.match_id = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    console.log('📊 [XP DEBUG] Found stats for', stats.length, 'players');
    
    // 4. Get home and away team users
    const homeUsers = await sequelize.query(`
      SELECT u.id, u."firstName", u."lastName", u.xp
      FROM users u
      JOIN "UserHomeMatches" uhm ON u.id = uhm."userId"
      WHERE uhm."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    const awayUsers = await sequelize.query(`
      SELECT u.id, u."firstName", u."lastName", u.xp
      FROM users u
      JOIN "UserAwayMatches" uam ON u.id = uam."userId"
      WHERE uam."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    // 5. Get MOTM votes
    const votes = await sequelize.query(`
      SELECT v.*, 
             voter."firstName" as "voterFirstName", voter."lastName" as "voterLastName",
             voted."firstName" as "votedFirstName", voted."lastName" as "votedLastName"
      FROM "Votes" v
      JOIN users voter ON v."voterId" = voter.id
      JOIN users voted ON v."votedForId" = voted.id
      WHERE v."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    // 6. Count votes per player
    const voteCountMap: Record<string, number> = {};
    for (const v of votes as any[]) {
      const votedId = String(v.votedForId);
      voteCountMap[votedId] = (voteCountMap[votedId] || 0) + 1;
    }
    
    // Find MOTM winner (most votes)
    let motmWinnerId: string | null = null;
    let maxVotes = 0;
    for (const [userId, count] of Object.entries(voteCountMap)) {
      if (count > maxVotes) {
        maxVotes = count;
        motmWinnerId = userId;
      }
    }
    
    // 7. XP Points Table (shared source of truth)
    const xpTable = xpPointsTable;
    
    // 8. Build detailed breakdown for each player
    const playerBreakdown: any[] = [];
    
    // Process home team
    for (const user of homeUsers as any[]) {
      const userId = String(user.id);
      const playerStats = (stats as any[]).find(s => String(s.userId) === userId);
      const isWinningTeam = matchResult === 'home_win';
      const isLosingTeam = matchResult === 'away_win';
      const isDraw = matchResult === 'draw';
      
      const breakdown: any = {
        id: userId,
        name: `${user.firstName} ${user.lastName}`,
        team: 'home',
        currentXP: user.xp,
        xpAwardedInMatch: playerStats?.xp_awarded || 0,
        stats: playerStats ? {
          goals: playerStats.goals || 0,
          assists: playerStats.assists || 0,
          cleanSheets: playerStats.cleanSheets || 0
        } : null,
        xpBreakdown: {
          teamResult: {
            type: isWinningTeam ? 'WIN' : (isDraw ? 'DRAW' : 'LOSS'),
            xp: isWinningTeam ? xpTable.winningTeam : (isDraw ? xpTable.draw : xpTable.losingTeam)
          },
          goals: playerStats ? {
            count: playerStats.goals || 0,
            xpPerGoal: isWinningTeam ? xpTable.goal.win : xpTable.goal.lose,
            totalXP: (playerStats.goals || 0) * (isWinningTeam ? xpTable.goal.win : xpTable.goal.lose)
          } : null,
          assists: playerStats ? {
            count: playerStats.assists || 0,
            xpPerAssist: isWinningTeam ? xpTable.assist.win : xpTable.assist.lose,
            totalXP: (playerStats.assists || 0) * (isWinningTeam ? xpTable.assist.win : xpTable.assist.lose)
          } : null,
          cleanSheets: playerStats ? {
            count: playerStats.cleanSheets || 0,
            xpPerCleanSheet: xpTable.cleanSheet,
            totalXP: (playerStats.cleanSheets || 0) * xpTable.cleanSheet
          } : null,
          motmVotes: {
            received: voteCountMap[userId] || 0,
            xpPerVote: isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose,
            totalXP: (voteCountMap[userId] || 0) * (isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose)
          },
          motmWinner: {
            selected: motmWinnerId === userId,
            xp: motmWinnerId === userId ? xpTable.motm : 0
          },
          captainPicks: {
            defensiveImpact: String(matchData.homeDefensiveImpactId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.defensiveImpact.win : xpTable.defensiveImpact.lose
            } : null,
            mentality: String(matchData.homeMentalityId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.mentality.win : xpTable.mentality.lose
            } : null
          }
        },
        calculatedTotalXP: 0
      };
      
      // Calculate total
      let total = breakdown.xpBreakdown.teamResult.xp;
      if (breakdown.xpBreakdown.goals) total += breakdown.xpBreakdown.goals.totalXP;
      if (breakdown.xpBreakdown.assists) total += breakdown.xpBreakdown.assists.totalXP;
      if (breakdown.xpBreakdown.cleanSheets) total += breakdown.xpBreakdown.cleanSheets.totalXP;
      total += breakdown.xpBreakdown.motmVotes.totalXP;
      total += breakdown.xpBreakdown.motmWinner.xp;
      if (breakdown.xpBreakdown.captainPicks.defensiveImpact) total += breakdown.xpBreakdown.captainPicks.defensiveImpact.xp;
      if (breakdown.xpBreakdown.captainPicks.mentality) total += breakdown.xpBreakdown.captainPicks.mentality.xp;
      breakdown.calculatedTotalXP = total;
      
      playerBreakdown.push(breakdown);
    }
    
    // Process away team
    for (const user of awayUsers as any[]) {
      const userId = String(user.id);
      const playerStats = (stats as any[]).find(s => String(s.userId) === userId);
      const isWinningTeam = matchResult === 'away_win';
      const isLosingTeam = matchResult === 'home_win';
      const isDraw = matchResult === 'draw';
      
      const breakdown: any = {
        id: userId,
        name: `${user.firstName} ${user.lastName}`,
        team: 'away',
        currentXP: user.xp,
        xpAwardedInMatch: playerStats?.xp_awarded || 0,
        stats: playerStats ? {
          goals: playerStats.goals || 0,
          assists: playerStats.assists || 0,
          cleanSheets: playerStats.cleanSheets || 0
        } : null,
        xpBreakdown: {
          teamResult: {
            type: isWinningTeam ? 'WIN' : (isDraw ? 'DRAW' : 'LOSS'),
            xp: isWinningTeam ? xpTable.winningTeam : (isDraw ? xpTable.draw : xpTable.losingTeam)
          },
          goals: playerStats ? {
            count: playerStats.goals || 0,
            xpPerGoal: isWinningTeam ? xpTable.goal.win : xpTable.goal.lose,
            totalXP: (playerStats.goals || 0) * (isWinningTeam ? xpTable.goal.win : xpTable.goal.lose)
          } : null,
          assists: playerStats ? {
            count: playerStats.assists || 0,
            xpPerAssist: isWinningTeam ? xpTable.assist.win : xpTable.assist.lose,
            totalXP: (playerStats.assists || 0) * (isWinningTeam ? xpTable.assist.win : xpTable.assist.lose)
          } : null,
          cleanSheets: playerStats ? {
            count: playerStats.cleanSheets || 0,
            xpPerCleanSheet: xpTable.cleanSheet,
            totalXP: (playerStats.cleanSheets || 0) * xpTable.cleanSheet
          } : null,
          motmVotes: {
            received: voteCountMap[userId] || 0,
            xpPerVote: isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose,
            totalXP: (voteCountMap[userId] || 0) * (isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose)
          },
          motmWinner: {
            selected: motmWinnerId === userId,
            xp: motmWinnerId === userId ? xpTable.motm : 0
          },
          captainPicks: {
            defensiveImpact: String(matchData.awayDefensiveImpactId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.defensiveImpact.win : xpTable.defensiveImpact.lose
            } : null,
            mentality: String(matchData.awayMentalityId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.mentality.win : xpTable.mentality.lose
            } : null
          }
        },
        calculatedTotalXP: 0
      };
      
      // Calculate total
      let total = breakdown.xpBreakdown.teamResult.xp;
      if (breakdown.xpBreakdown.goals) total += breakdown.xpBreakdown.goals.totalXP;
      if (breakdown.xpBreakdown.assists) total += breakdown.xpBreakdown.assists.totalXP;
      if (breakdown.xpBreakdown.cleanSheets) total += breakdown.xpBreakdown.cleanSheets.totalXP;
      total += breakdown.xpBreakdown.motmVotes.totalXP;
      total += breakdown.xpBreakdown.motmWinner.xp;
      if (breakdown.xpBreakdown.captainPicks.defensiveImpact) total += breakdown.xpBreakdown.captainPicks.defensiveImpact.xp;
      if (breakdown.xpBreakdown.captainPicks.mentality) total += breakdown.xpBreakdown.captainPicks.mentality.xp;
      breakdown.calculatedTotalXP = total;
      
      playerBreakdown.push(breakdown);
    }
    
    ctx.body = {
      success: true,
      matchId,
      matchInfo: {
        homeTeam: matchData.homeTeamName,
        awayTeam: matchData.awayTeamName,
        homeGoals,
        awayGoals,
        result: matchResult,
        status: matchData.status,
        homeCaptainId: matchData.homeCaptainId,
        awayCaptainId: matchData.awayCaptainId,
        captainPicks: {
          homeDefensiveImpactId: matchData.homeDefensiveImpactId,
          awayDefensiveImpactId: matchData.awayDefensiveImpactId,
          homeMentalityId: matchData.homeMentalityId,
          awayMentalityId: matchData.awayMentalityId
        }
      },
      xpPointsTable: xpTable,
      // Includes both individual MOTM vote XP and MOTM winner bonus
      votes: votes,
      voteCountByPlayer: voteCountMap,
      homeTeamPlayers: homeUsers,
      awayTeamPlayers: awayUsers,
      playerXPBreakdown: playerBreakdown,
      summary: {
        totalPlayersWithStats: stats.length,
        totalVotes: (votes as any[]).length
      }
    };
    
  } catch (err) {
    console.error('📊 [XP DEBUG] Error:', err);
    ctx.status = 500;
    ctx.body = { 
      success: false, 
      message: 'Failed to get XP breakdown',
      error: err instanceof Error ? err.message : String(err)
    };
  }
};

// Export all functions
export {
  // All exported above
};

import MatchStatistics from '../models/MatchStatistics';
import Match from '../models/Match';
import Vote from '../models/Vote';
import { Op, QueryTypes } from 'sequelize';
import User from '../models/User';
import League from '../models/League';
import { xpAchievements } from './xpAchievements';
import { xpPointsTable } from './xpPointsTable';
import sequelize from '../config/database';
import { computeAchievementState, toAchievementMatchInput } from './achievementChecker';

// Helper: Get all stats for a user in a league
async function getUserLeagueStats(userId: string, leagueId: string) {
  const stats = await MatchStatistics.findAll({
    where: { user_id: userId },
    include: [
      {
        model: Match,
        as: 'match',
        where: { leagueId, status: 'RESULT_PUBLISHED' },
        include: [
          { model: User as any, as: 'homeTeamUsers', attributes: ['id'] },
          { model: User as any, as: 'awayTeamUsers', attributes: ['id'] },
        ],
      },
    ],
  });

  // Calculate stats for achievements
  let hatTrickMatches = 0;
  let captainWins = 0;
  let consecutiveAssists = 0;
  let consecutiveGoals = 0;
  let captainPerformancePicks = 0;
  let consecutiveMOTM = 0;
  let consecutiveCleanSheetWins = 0;
  let topSpotMatches = 0;
  let consecutiveWins = 0;

  // For consecutive stats, sort by match date
  const getTime = (m: any) => {
    const d = (m?.date ?? m?.start ?? m?.createdAt ?? 0);
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const sortedStats = stats.sort((a, b) => getTime(a.match) - getTime(b.match));

  // Example logic (customize as per your actual data):
  let assistStreak = 0, goalStreak = 0, motmStreak = 0, winStreak = 0, cleanSheetWinStreak = 0;
  for (const stat of sortedStats) {
    // Hat trick
    if (stat.goals >= 3) hatTrickMatches++;

    // Consecutive assists
    if (stat.assists > 0) assistStreak++;
    else assistStreak = 0;
    if (assistStreak > consecutiveAssists) consecutiveAssists = assistStreak;

    // Consecutive goals
    if (stat.goals > 0) goalStreak++;
    else goalStreak = 0;
    if (goalStreak > consecutiveGoals) consecutiveGoals = goalStreak;

    // Consecutive wins (you need to check if user's team won)
    if (stat.match) {
      const isHome = stat.match.homeTeamUsers?.some((u: any) => u.id === userId);
      const isAway = stat.match.awayTeamUsers?.some((u: any) => u.id === userId);
      let won = false;
      if (isHome && (stat.match.homeTeamGoals ?? 0) > (stat.match.awayTeamGoals ?? 0)) won = true;
      if (isAway && (stat.match.awayTeamGoals ?? 0) > (stat.match.homeTeamGoals ?? 0)) won = true;
      if (won) winStreak++;
      else winStreak = 0;
      if (winStreak > consecutiveWins) consecutiveWins = winStreak;

      
      // Clean sheet win
      if (won && stat.cleanSheets > 0) cleanSheetWinStreak++;
      else cleanSheetWinStreak = 0;
      if (cleanSheetWinStreak > consecutiveCleanSheetWins) consecutiveCleanSheetWins = cleanSheetWinStreak;
    }
  }

  // Captain wins (if user was captain and team won)
  const captainMatches = await Match.findAll({
    where: {
      leagueId,
      status: 'RESULT_PUBLISHED',
      [Op.or]: [{ homeCaptainId: userId }, { awayCaptainId: userId }]
    }
  });
  for (const match of captainMatches) {
    const isHome = match.homeCaptainId === userId;
    const isAway = match.awayCaptainId === userId;
    if (isHome && (match.homeTeamGoals ?? 0) > (match.awayTeamGoals ?? 0)) captainWins++;
    if (isAway && (match.awayTeamGoals ?? 0) > (match.homeTeamGoals ?? 0)) captainWins++;
  }

  // Captain's performance pick (custom logic, e.g., MVP votes)
  // You need to implement this based on your app's logic
  // For now, let's assume you have a way to count it:
  // captainPerformancePicks = await getCaptainPerformancePicks(userId, leagueId);

  // Man of the Match (MOTM) streak
  // Count consecutive matches where user got most votes
  const votes = await Vote.findAll({
    where: { votedForId: userId },
    include: [{
      model: Match,
      as: 'votedMatch',
      where: { leagueId, status: 'RESULT_PUBLISHED' }
    }]
  });
  // You need to process votes to determine if user was MOTM for each match, and count streaks

  // Top spot matches (requires league table logic)
  // topSpotMatches = await getTopSpotMatches(userId, leagueId);

  return {
    hatTrickMatches,
    captainWins,
    consecutiveAssists,
    consecutiveGoals,
    captainPerformancePicks,
    consecutiveMOTM,
    consecutiveCleanSheetWins,
    topSpotMatches,
    consecutiveWins,
  };
}

// Get all stats for a user across all leagues
async function getUserAllLeaguesStats(userId: string) {
  const user = await User.findByPk(userId, {
    include: [{
      model: League,
      as: 'leagues'
    }]
  });

  if (!user) return null;

  const allStats = {
    hatTrickMatches: 0,
    captainWins: 0,
    consecutiveAssists: 0,
    consecutiveGoals: 0,
    captainPerformancePicks: 0,
    consecutiveMOTM: 0,
    consecutiveCleanSheetWins: 0,
    topSpotMatches: 0,
    consecutiveWins: 0,
  };

  // Get stats from all leagues
  for (const league of (user as any).leagues || []) {
    const leagueStats = await getUserLeagueStats(userId, league.id);
    allStats.hatTrickMatches += leagueStats.hatTrickMatches;
    allStats.captainWins += leagueStats.captainWins;
    allStats.consecutiveAssists = Math.max(allStats.consecutiveAssists, leagueStats.consecutiveAssists);
    allStats.consecutiveGoals = Math.max(allStats.consecutiveGoals, leagueStats.consecutiveGoals);
    allStats.captainPerformancePicks += leagueStats.captainPerformancePicks;
    allStats.consecutiveMOTM = Math.max(allStats.consecutiveMOTM, leagueStats.consecutiveMOTM);
    allStats.consecutiveCleanSheetWins = Math.max(allStats.consecutiveCleanSheetWins, leagueStats.consecutiveCleanSheetWins);
    allStats.topSpotMatches += leagueStats.topSpotMatches;
    allStats.consecutiveWins = Math.max(allStats.consecutiveWins, leagueStats.consecutiveWins);
  }

  return allStats;
}

export async function calculateAndAwardXPAchievements(userId: string, leagueId?: string) {
  console.log(`Starting XP achievement sync for user ${userId}${leagueId ? ` in league ${leagueId}` : ''}`);

  const user = await User.findByPk(userId);
  if (!user) {
    console.log(`User ${userId} not found for achievement sync`);
    return;
  }

  const Home = (sequelize.models as any)?.UserHomeMatches;
  const Away = (sequelize.models as any)?.UserAwayMatches;
  const startedAt = Date.now();
  const [homeMembershipRows, awayMembershipRows] = await Promise.all([
    Home ? Home.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
    Away ? Away.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
  ]);
  const matchIds = Array.from(
    new Set(
      [...(homeMembershipRows as any[]), ...(awayMembershipRows as any[])]
        .map((r: any) => String(r.matchId || ''))
        .filter((id: string) => id !== '')
    )
  );

  const previousAchievementIds: string[] = Array.isArray(user.achievements)
    ? user.achievements.map((id: unknown) => String(id))
    : [];
  const xpAchievementIdSet = new Set(xpAchievements.map((a) => a.id));
  const nonXpAchievementIds = previousAchievementIds.filter((id) => !xpAchievementIdSet.has(id));
  const previousXpAchievementIds = previousAchievementIds.filter((id) => xpAchievementIdSet.has(id));

  if (matchIds.length === 0) {
    const nextAchievementIds = nonXpAchievementIds;
    const noChange =
      nextAchievementIds.length === previousAchievementIds.length &&
      nextAchievementIds.every((id, idx) => id === previousAchievementIds[idx]);
    if (!noChange) {
      user.achievements = nextAchievementIds;
      await user.save();
    }
    console.log(`User ${userId} has no matches. XP achievements cleared.`);
    return;
  }

  const playedMatchWhere: any = { id: { [Op.in]: matchIds as any }, status: 'RESULT_PUBLISHED' };
  if (leagueId) playedMatchWhere.leagueId = leagueId;

  const playedMatches = await Match.findAll({
    where: playedMatchWhere,
    attributes: [
      'id',
      'leagueId',
      'homeTeamGoals',
      'awayTeamGoals',
      'date',
      'start',
      'createdAt',
      'homeCaptainId',
      'awayCaptainId',
      'homeDefensiveImpactId',
      'awayDefensiveImpactId',
      'homeMentalityId',
      'awayMentalityId',
    ],
    raw: true,
  }) as any[];

  if (playedMatches.length === 0) {
    const nextAchievementIds = nonXpAchievementIds;
    const noChange =
      nextAchievementIds.length === previousAchievementIds.length &&
      nextAchievementIds.every((id, idx) => id === previousAchievementIds[idx]);
    if (!noChange) {
      user.achievements = nextAchievementIds;
      await user.save();
    }
    console.log(`User ${userId} has no RESULT_PUBLISHED matches for this scope. XP achievements cleared.`);
    return;
  }

  const leagueIds = Array.from(
    new Set(playedMatches.map((m: any) => String(m.leagueId || '')).filter((id: string) => id !== ''))
  );
  const playedMatchIds = playedMatches.map((m: any) => String(m.id)).filter((id: string) => id !== '');

  const [leagueTotalRows, homeTeamRows, awayTeamRows, voteRows, statsRows] = await Promise.all([
    leagueIds.length > 0
      ? Match.findAll({
          where: { leagueId: { [Op.in]: leagueIds as any }, status: 'RESULT_PUBLISHED' },
          attributes: ['leagueId', [sequelize.fn('COUNT', sequelize.col('id')), 'totalMatches']],
          group: ['leagueId'],
          raw: true,
        })
      : Promise.resolve([]),
    Home && playedMatchIds.length > 0
      ? Home.findAll({
          where: { matchId: { [Op.in]: playedMatchIds as any } },
          attributes: ['matchId', 'userId'],
          raw: true,
        })
      : Promise.resolve([]),
    Away && playedMatchIds.length > 0
      ? Away.findAll({
          where: { matchId: { [Op.in]: playedMatchIds as any } },
          attributes: ['matchId', 'userId'],
          raw: true,
        })
      : Promise.resolve([]),
    playedMatchIds.length > 0
      ? Vote.findAll({
          where: { matchId: { [Op.in]: playedMatchIds as any } },
          attributes: ['matchId', 'votedForId'],
          raw: true,
        })
      : Promise.resolve([]),
    playedMatchIds.length > 0
      ? MatchStatistics.findAll({
          where: { user_id: userId, match_id: { [Op.in]: playedMatchIds as any } },
          attributes: ['match_id', 'goals', 'assists'],
          raw: true,
        })
      : Promise.resolve([]),
  ]);

  const totalMatchesByLeague: Record<string, number> = {};
  for (const row of leagueTotalRows as any[]) {
    const key = String(row.leagueId || '').trim();
    if (!key) continue;
    totalMatchesByLeague[key] = Number(row.totalMatches || 0);
  }

  const homeUsersByMatch = new Map<string, Set<string>>();
  const awayUsersByMatch = new Map<string, Set<string>>();
  const votesByMatch = new Map<string, string[]>();

  for (const row of homeTeamRows as any[]) {
    const matchId = String(row.matchId || '').trim();
    const playerId = String(row.userId || '').trim();
    if (!matchId || !playerId) continue;
    if (!homeUsersByMatch.has(matchId)) homeUsersByMatch.set(matchId, new Set<string>());
    homeUsersByMatch.get(matchId)!.add(playerId);
  }
  for (const row of awayTeamRows as any[]) {
    const matchId = String(row.matchId || '').trim();
    const playerId = String(row.userId || '').trim();
    if (!matchId || !playerId) continue;
    if (!awayUsersByMatch.has(matchId)) awayUsersByMatch.set(matchId, new Set<string>());
    awayUsersByMatch.get(matchId)!.add(playerId);
  }
  for (const row of voteRows as any[]) {
    const matchId = String(row.matchId || '').trim();
    const votedForId = String(row.votedForId || '').trim();
    if (!matchId || !votedForId) continue;
    if (!votesByMatch.has(matchId)) votesByMatch.set(matchId, []);
    votesByMatch.get(matchId)!.push(votedForId);
  }

  const statsByMatch = new Map<string, { goals: number; assists: number }>();
  for (const row of statsRows as any[]) {
    statsByMatch.set(String(row.match_id), {
      goals: Number(row.goals || 0),
      assists: Number(row.assists || 0),
    });
  }

  const achievementMatches = playedMatches.map((m: any) => {
    const matchId = String(m.id || '');
    const homeIds = Array.from(homeUsersByMatch.get(matchId) || []);
    const awayIds = Array.from(awayUsersByMatch.get(matchId) || []);
    const votedForIds = votesByMatch.get(matchId) || [];
    return toAchievementMatchInput({
      ...m,
      homeTeamUsers: homeIds.map((id) => ({ id })),
      awayTeamUsers: awayIds.map((id) => ({ id })),
      votes: votedForIds.map((votedForId) => ({ votedForId })),
    });
  });

  const computed = computeAchievementState(userId, achievementMatches, statsByMatch, {
    totalMatchesByLeague,
  });
  const nextXpAchievementIds = computed.xpAchievementInstances;
  const nextAchievementIds = [...nonXpAchievementIds, ...nextXpAchievementIds];

  const changed =
    nextAchievementIds.length !== previousAchievementIds.length ||
    nextAchievementIds.some((id, idx) => id !== previousAchievementIds[idx]);

  if (changed) {
    user.achievements = nextAchievementIds;
    await user.save();
  }

  const toCountMap = (ids: string[]): Record<string, number> => {
    const map: Record<string, number> = {};
    ids.forEach((id) => {
      map[id] = (map[id] || 0) + 1;
    });
    return map;
  };

  const previousCount = toCountMap(previousXpAchievementIds);
  const nextCount = toCountMap(nextXpAchievementIds);
  const allRewardIds = Array.from(xpAchievementIdSet);
  const deltas = allRewardIds
    .map((id) => ({
      id,
      before: previousCount[id] || 0,
      after: nextCount[id] || 0,
      delta: (nextCount[id] || 0) - (previousCount[id] || 0),
    }))
    .filter((row) => row.delta !== 0);

  if (deltas.length > 0) {
    console.log(`Achievement sync changes for ${userId}:`, deltas);
  } else {
    console.log(`No XP achievement count changes for ${userId}`);
  }
  console.log(
    `[XP Sync] user=${userId} playedMatches=${playedMatchIds.length} leagues=${leagueIds.length} durationMs=${Date.now() - startedAt}`
  );

  // --- XP Awarding Logic for Completed Match ---
  if (leagueId) {
    // Find all completed matches for this user in this league
    const matches = await Match.findAll({
      where: { leagueId, status: 'RESULT_PUBLISHED' },
      include: [
        { model: User, as: 'homeTeamUsers' },
        { model: User, as: 'awayTeamUsers' },
        { model: Vote, as: 'votes' },
      ]
    });
    // Find the most recent completed match (the one just completed)
    const match = matches[matches.length - 1];
    if (!match) return;
    // Get all users in this match
    const homeTeamUsers = ((match as any).homeTeamUsers || []);
    const awayTeamUsers = ((match as any).awayTeamUsers || []);
    const allPlayers = [...homeTeamUsers, ...awayTeamUsers];
    // Get all stats for this match
    const stats = await MatchStatistics.findAll({ where: { match_id: match.id } });
    // Get all votes for this match
    const votes = await Vote.findAll({ where: { matchId: match.id } });
    // Determine MOTM (most votes)
    const voteCounts: Record<string, number> = {};
    votes.forEach(vote => {
      const id = String(vote.votedForId);
      voteCounts[id] = (voteCounts[id] || 0) + 1;
    });
    let motmId: string | null = null;
    let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]) => {
      if (count > maxVotes) {
        motmId = id;
        maxVotes = count;
      }
    });
    // Award XP for each player
    for (const player of allPlayers) {
      let xp = 0;
      const stat = stats.find(s => s.user_id === player.id);
      const isHome = homeTeamUsers.some((u: any) => u.id === player.id);
      const isAway = awayTeamUsers.some((u: any) => u.id === player.id);
      const homeGoals = match.homeTeamGoals ?? 0;
      const awayGoals = match.awayTeamGoals ?? 0;
      // Win/Draw/Loss
      let teamResult: 'win' | 'draw' | 'lose' = 'lose';
      if (isHome && homeGoals > awayGoals) teamResult = 'win';
      else if (isAway && awayGoals > homeGoals) teamResult = 'win';
      else if (homeGoals === awayGoals) teamResult = 'draw';
      if (teamResult === 'win') xp += xpPointsTable.winningTeam;
      else if (teamResult === 'draw') xp += xpPointsTable.draw;
      else xp += xpPointsTable.losingTeam;
      // Goals
      if (stat && stat.goals) xp += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
      // Assists
      if (stat && stat.assists) xp += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
      // Clean Sheets (Goalkeeper)
      if (stat && stat.cleanSheets) xp += xpPointsTable.cleanSheet * stat.cleanSheets;
      // MOTM Winner bonus removed - only individual votes count
      // MOTM Votes
      if (voteCounts[player.id]) xp += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[player.id];
      
      // Defensive Impact (Captain Pick)
      if (match.homeDefensiveImpactId === player.id || match.awayDefensiveImpactId === player.id) {
        xp += (teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose);
        console.log(`🛡️  Defensive Impact XP: User ${player.id} gets ${teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose} XP`);
      }
      
      // Mentality (Captain Pick)
      if (match.homeMentalityId === player.id || match.awayMentalityId === player.id) {
        xp += (teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose);
        console.log(`🧠 Mentality XP: User ${player.id} gets ${teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose} XP`);
      }
      
      // TODO: Streak Bonuses (if you have logic to determine streaks, add here)
      // Award XP
      const user = await User.findByPk(player.id);
      if (user) {
        user.xp = (user.xp || 0) + xp;
        await user.save();
        console.log(`💰 XP REWARD! User ${user.id}: +${xp} XP for match ${match.id}`);
      }
    }
  }
}

export async function awardXPAchievement(userId: string, achievementId: string) {
  const achievement = xpAchievements.find(a => a.id === achievementId);
  if (!achievement) return;

  const user = await User.findByPk(userId);
  if (!user) return;

  if (user.achievements?.includes(achievementId)) return; // already awarded

  const oldXP = user.xp || 0;
  user.xp = oldXP + achievement.xp;
  user.achievements = [...(user.achievements || []), achievementId];
  await user.save();
  
  console.log(`💰 XP REWARD! User ${userId}: +${achievement.xp} XP for "${achievement.definition}"`);
  console.log(`   Total XP: ${oldXP} → ${user.xp} (+${achievement.xp})`);
}

// Global XP calculation for all users
export async function calculateAllUsersXP() {
  console.log('🚀 Starting global XP calculation for all users...');
  
  const users = await User.findAll();
  let totalAwarded = 0;
  
  for (const user of users) {
    try {
      await calculateAndAwardXPAchievements(user.id);
      totalAwarded++;
    } catch (error) {
      console.error(`❌ Error calculating XP for user ${user.id}:`, error);
    }
  }
  
  console.log(`✅ Completed XP calculation for ${totalAwarded} users`);
}

// Manual trigger for immediate calculation
export async function triggerImmediateXPCalculation() {
  console.log('⚡ Triggering immediate XP calculation...');
  await calculateAllUsersXP();
}

// Award XP for a specific match - called when both captains confirm the result
export async function awardXPForMatch(matchId: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏆 STARTING XP AWARD FOR MATCH ${matchId}`);
  console.log(`${'='.repeat(60)}`);
  
  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
      { model: Vote, as: 'votes' },
    ]
  });

  if (!match) {
    console.log(`❌ Match ${matchId} not found`);
    return;
  }

  // Get all users in this match
  const homeTeamUsers = ((match as any).homeTeamUsers || []);
  const awayTeamUsers = ((match as any).awayTeamUsers || []);
  const allPlayers = [...homeTeamUsers, ...awayTeamUsers];

  console.log(`📋 Match ${matchId}:`);
  console.log(`   Home players (${homeTeamUsers.length}):`, homeTeamUsers.map((u: any) => ({ id: u.id, name: u.firstName })));
  console.log(`   Away players (${awayTeamUsers.length}):`, awayTeamUsers.map((u: any) => ({ id: u.id, name: u.firstName })));
  console.log(`   Total players to process: ${allPlayers.length}`);

  // Get all stats for this match using RAW SQL to ensure we get actual DB values
  console.log(`🔎 Querying MatchStatistics for match_id: ${matchId}`);
  
  const allStats = await sequelize.query<any>(
    `SELECT * FROM "MatchStatistics" WHERE match_id = :matchId`,
    { 
      replacements: { matchId },
      type: QueryTypes.SELECT 
    }
  );
  
  console.log(`📊 Found ${allStats.length} player stats in MatchStatistics table for match ${matchId}`);
  
  // Log all stats for debugging
  if (allStats.length === 0) {
    console.log(`   ⚠️ NO STATS FOUND IN DATABASE FOR THIS MATCH!`);
    console.log(`   🔎 Checking if any stats exist at all...`);
    const anyStats = await sequelize.query<any>(
      `SELECT match_id, user_id, goals, assists, "cleanSheets" FROM "MatchStatistics" LIMIT 3`,
      { type: QueryTypes.SELECT }
    );
    console.log(`   📋 Sample stats in DB:`, anyStats);
  } else {
    allStats.forEach((s: any) => {
      console.log(`   📈 Stats for user_id ${s.user_id}:`);
      console.log(`      goals=${s.goals}, assists=${s.assists}, cleanSheets=${s.cleanSheets}, defence=${s.defence}`);
    });
  }

  // Get all votes for this match
  const votes = await Vote.findAll({ where: { matchId: matchId } });
  
  // Determine MOTM (most votes)
  const voteCounts: Record<string, number> = {};
  votes.forEach(vote => {
    const id = String(vote.votedForId);
    voteCounts[id] = (voteCounts[id] || 0) + 1;
  });
  let motmId: string | null = null;
  let maxVotes = 0;
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      motmId = id;
      maxVotes = count;
    }
  });
  console.log(`🌟 MOTM for match ${matchId}: Player ${motmId} with ${maxVotes} votes`);

  const homeGoals = match.homeTeamGoals ?? 0;
  const awayGoals = match.awayTeamGoals ?? 0;
  console.log(`⚽ Score: Home ${homeGoals} - ${awayGoals} Away`);

  // Award XP for each player
  for (const player of allPlayers) {
    let xp = 0;
    const xpBreakdown: string[] = [];
    
    // Find stats for this player - raw SQL result so access directly
    const stat = allStats.find((s: any) => {
      const statUserId = String(s.user_id);
      const playerId = String(player.id);
      return statUserId === playerId;
    });
    
    // Raw SQL result - access properties directly
    const statValues = stat ? {
      goals: Number(stat.goals) || 0,
      assists: Number(stat.assists) || 0,
      cleanSheets: Number(stat.cleanSheets) || 0,
      defence: Number(stat.defence) || 0
    } : null;
    
    console.log(`🔍 Player ${player.id} (${(player as any).firstName}) stats lookup:`);
    console.log(`   Found stat record: ${stat ? 'YES' : 'NO'}`);
    if (stat) {
      console.log(`   Raw stat from DB:`, JSON.stringify(stat));
    }
    if (statValues) {
      console.log(`   Parsed values - Goals: ${statValues.goals}, Assists: ${statValues.assists}, CleanSheets: ${statValues.cleanSheets}, Defence: ${statValues.defence}`);
    }
    
    const isHome = homeTeamUsers.some((u: any) => String(u.id) === String(player.id));
    const isAway = awayTeamUsers.some((u: any) => String(u.id) === String(player.id));

    // Win/Draw/Loss
    let teamResult: 'win' | 'draw' | 'lose' = 'lose';
    if (isHome && homeGoals > awayGoals) teamResult = 'win';
    else if (isAway && awayGoals > homeGoals) teamResult = 'win';
    else if (homeGoals === awayGoals) teamResult = 'draw';

    console.log(`   Team: ${isHome ? 'HOME' : 'AWAY'}, Result: ${teamResult.toUpperCase()}`);

    if (teamResult === 'win') {
      xp += xpPointsTable.winningTeam;
      xpBreakdown.push(`Win: +${xpPointsTable.winningTeam}`);
    } else if (teamResult === 'draw') {
      xp += xpPointsTable.draw;
      xpBreakdown.push(`Draw: +${xpPointsTable.draw}`);
    } else {
      xp += xpPointsTable.losingTeam;
      xpBreakdown.push(`Loss: +${xpPointsTable.losingTeam}`);
    }

    // Goals - use statValues
    const goals = statValues?.goals || 0;
    console.log(`   📊 Goals check: goals=${goals}, teamResult=${teamResult}`);
    if (goals > 0) {
      const goalXP = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * goals;
      xp += goalXP;
      xpBreakdown.push(`Goals (${goals}): +${goalXP}`);
      console.log(`   ⚽ Adding ${goalXP} XP for ${goals} goals`);
    }

    // Assists - use statValues
    const assists = statValues?.assists || 0;
    console.log(`   📊 Assists check: assists=${assists}, teamResult=${teamResult}`);
    if (assists > 0) {
      const assistXP = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * assists;
      xp += assistXP;
      xpBreakdown.push(`Assists (${assists}): +${assistXP}`);
      console.log(`   🎯 Adding ${assistXP} XP for ${assists} assists`);
    }

    // Clean Sheets - use statValues
    const cleanSheets = statValues?.cleanSheets || 0;
    console.log(`   📊 CleanSheets check: cleanSheets=${cleanSheets}`);
    if (cleanSheets > 0) {
      const cleanSheetXP = xpPointsTable.cleanSheet * cleanSheets;
      xp += cleanSheetXP;
      xpBreakdown.push(`Clean Sheets (${cleanSheets}): +${cleanSheetXP}`);
      console.log(`   🧤 Adding ${cleanSheetXP} XP for ${cleanSheets} clean sheets`);
    }

    // Impact/Defence - use statValues
    const defence = statValues?.defence || 0;
    if (defence > 0) {
      const defenceXP = (teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose) * defence;
      xp += defenceXP;
      xpBreakdown.push(`Defence Impact (${defence}): +${defenceXP}`);
    }

    // MOTM Winner bonus removed - only individual votes count

    // MOTM Votes received
    if (voteCounts[player.id]) {
      const voteXP = (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[player.id];
      xp += voteXP;
      xpBreakdown.push(`MOTM Votes (${voteCounts[player.id]}): +${voteXP}`);
    }

    // Defensive Impact (Captain Pick)
    if ((match as any).homeDefensiveImpactId === player.id || (match as any).awayDefensiveImpactId === player.id) {
      const defImpactXP = (teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose);
      xp += defImpactXP;
      xpBreakdown.push(`Captain Pick - Defensive Impact: +${defImpactXP}`);
    }

    // Mentality (Captain Pick)
    if ((match as any).homeMentalityId === player.id || (match as any).awayMentalityId === player.id) {
      const mentalityXP = (teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose);
      xp += mentalityXP;
      xpBreakdown.push(`Captain Pick - Mentality: +${mentalityXP}`);
    }

    // Update match_statistics with xp_awarded using raw SQL (snake_case table name)
    if (stat) {
      try {
        await sequelize.query(
          `UPDATE match_statistics SET xp_awarded = :xp WHERE match_id = :matchId AND user_id = :userId`,
          { replacements: { xp, matchId, userId: player.id } }
        );
        console.log(`   📝 Updated match_statistics record with xp_awarded: ${xp}`);
      } catch (statErr) {
        console.error(`   ❌ Failed to update match_statistics:`, statErr);
      }
    }

    // Update User's total XP - Use RAW SQL to ensure it saves
    try {
      // Get current XP
      const userResult = await sequelize.query<any>(
        `SELECT id, "firstName", xp FROM users WHERE id = :userId`,
        { replacements: { userId: player.id }, type: QueryTypes.SELECT }
      );
      
      if (userResult.length > 0) {
        const oldXP = userResult[0].xp || 0;
        const newXP = oldXP + xp;
        
        // Update XP using raw SQL
        await sequelize.query(
          `UPDATE users SET xp = :newXP WHERE id = :userId`,
          { replacements: { newXP, userId: player.id } }
        );
        
        console.log(`💰 XP AWARDED! User ${player.id} (${userResult[0].firstName || 'Unknown'}): +${xp} XP`);
        console.log(`   Breakdown: ${xpBreakdown.join(', ')}`);
        console.log(`   Total XP: ${oldXP} → ${newXP}`);
        
        // Verify the update
        const verifyResult = await sequelize.query<any>(
          `SELECT xp FROM users WHERE id = :userId`,
          { replacements: { userId: player.id }, type: QueryTypes.SELECT }
        );
        console.log(`   ✅ Verified DB XP: ${verifyResult[0]?.xp}`);
      } else {
        console.log(`   ⚠️ User ${player.id} not found in database!`);
      }
    } catch (userErr) {
      console.error(`   ❌ Failed to update User XP:`, userErr);
    }
  }

  console.log(`✅ Completed XP awards for match ${matchId}`);
  console.log(`${'='.repeat(60)}\n`);
}

// Award XP for a single player immediately when they submit stats
export async function awardXPForPlayer(userId: string, matchId: string, statRecord: any): Promise<number> {
  console.log(`🎯 Calculating XP for player ${userId} in match ${matchId}`);

  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ]
  });

  if (!match) {
    console.log(`❌ Match ${matchId} not found`);
    return 0;
  }

  const homeTeamUsers = ((match as any).homeTeamUsers || []);
  const awayTeamUsers = ((match as any).awayTeamUsers || []);
  
  const isHome = homeTeamUsers.some((u: any) => String(u.id) === String(userId));
  const isAway = awayTeamUsers.some((u: any) => String(u.id) === String(userId));
  
  if (!isHome && !isAway) {
    console.log(`❌ Player ${userId} not found in match teams`);
    return 0;
  }

  const homeGoals = match.homeTeamGoals ?? 0;
  const awayGoals = match.awayTeamGoals ?? 0;

  // Determine win/draw/lose
  let teamResult: 'win' | 'draw' | 'lose' = 'lose';
  if (isHome && homeGoals > awayGoals) teamResult = 'win';
  else if (isAway && awayGoals > homeGoals) teamResult = 'win';
  else if (homeGoals === awayGoals) teamResult = 'draw';

  let xp = 0;
  const xpBreakdown: string[] = [];

  // Win/Draw/Loss XP
  if (teamResult === 'win') {
    xp += xpPointsTable.winningTeam;
    xpBreakdown.push(`Win: +${xpPointsTable.winningTeam}`);
  } else if (teamResult === 'draw') {
    xp += xpPointsTable.draw;
    xpBreakdown.push(`Draw: +${xpPointsTable.draw}`);
  } else {
    xp += xpPointsTable.losingTeam;
    xpBreakdown.push(`Loss: +${xpPointsTable.losingTeam}`);
  }

  // Goals XP
  const goals = statRecord.goals || 0;
  if (goals > 0) {
    const goalXP = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * goals;
    xp += goalXP;
    xpBreakdown.push(`Goals (${goals}): +${goalXP}`);
  }

  // Assists XP
  const assists = statRecord.assists || 0;
  if (assists > 0) {
    const assistXP = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * assists;
    xp += assistXP;
    xpBreakdown.push(`Assists (${assists}): +${assistXP}`);
  }

  // Clean Sheets XP
  const cleanSheets = statRecord.cleanSheets || 0;
  if (cleanSheets > 0) {
    const cleanSheetXP = xpPointsTable.cleanSheet * cleanSheets;
    xp += cleanSheetXP;
    xpBreakdown.push(`Clean Sheets (${cleanSheets}): +${cleanSheetXP}`);
  }

  // Defence XP
  const defence = statRecord.defence || 0;
  if (defence > 0) {
    const defenceXP = (teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose) * defence;
    xp += defenceXP;
    xpBreakdown.push(`Defence (${defence}): +${defenceXP}`);
  }

  // Update MatchStatistics with xpAwarded
  await statRecord.update({ xpAwarded: xp });

  // Update User's total XP
  const user = await User.findByPk(userId);
  if (user) {
    const oldXP = user.xp || 0;
    user.xp = oldXP + xp;
    await user.save();
    console.log(`💰 XP AWARDED! User ${userId}: +${xp} XP`);
    console.log(`   Breakdown: ${xpBreakdown.join(', ')}`);
    console.log(`   Total XP: ${oldXP} → ${user.xp}`);
  }

  return xp;
}


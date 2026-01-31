import MatchStatistics from '../models/MatchStatistics';
import Match from '../models/Match';
import Vote from '../models/Vote';
import { Op } from 'sequelize';
import User from '../models/User';
import League from '../models/League';
import { xpAchievements } from './xpAchievements';
import { xpPointsTable } from './xpPointsTable';

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
  console.log(`🎯 Starting XP calculation for user ${userId}${leagueId ? ` in league ${leagueId}` : ' across all leagues'}`);
  
  let stats;
  
  if (leagueId) {
    // Single league calculation
    stats = await getUserLeagueStats(userId, leagueId);
  } else {
    // All leagues calculation
    stats = await getUserAllLeaguesStats(userId);
  }

  if (!stats) {
    console.log(`❌ No stats found for user ${userId}`);
    return;
  }

  console.log(`📊 User ${userId} stats:`, {
    hatTricks: stats.hatTrickMatches,
    captainWins: stats.captainWins,
    consecutiveAssists: stats.consecutiveAssists,
    consecutiveGoals: stats.consecutiveGoals,
    captainPerformancePicks: stats.captainPerformancePicks,
    consecutiveMOTM: stats.consecutiveMOTM,
    consecutiveCleanSheetWins: stats.consecutiveCleanSheetWins,
    topSpotMatches: stats.topSpotMatches,
    consecutiveWins: stats.consecutiveWins
  });

  const awarded: string[] = [];

  for (const ach of xpAchievements) {
    let achieved = false;
    let reason = '';
    
    // Check if achievement is already awarded
    const user = await User.findByPk(userId);
    if (!user) continue;
    
    if (user.achievements?.includes(ach.id)) {
      console.log(`✅ Achievement '${ach.id}' already awarded to user ${userId}`);
      continue;
    }

    if (ach.id === "hat_trick_3_matches" && stats.hatTrickMatches >= 3) { 
      achieved = true; 
      reason = `Hat tricks: ${stats.hatTrickMatches}`; 
    }
    if (ach.id === "captain_5_wins" && stats.captainWins >= 5) { 
      achieved = true; 
      reason = `Captain wins: ${stats.captainWins}`; 
    }
    if (ach.id === "assist_10_consecutive" && stats.consecutiveAssists >= 10) { 
      achieved = true; 
      reason = `Consecutive assists: ${stats.consecutiveAssists}`; 
    }
    if (ach.id === "scoring_10_consecutive" && stats.consecutiveGoals >= 10) { 
      achieved = true; 
      reason = `Consecutive goals: ${stats.consecutiveGoals}`; 
    }
    if (ach.id === "captain_performance_3" && stats.captainPerformancePicks >= 3) { 
      achieved = true; 
      reason = `Captain performance picks: ${stats.captainPerformancePicks}`; 
    }
    if (ach.id === "motm_4_consecutive" && stats.consecutiveMOTM >= 4) { 
      achieved = true; 
      reason = `Consecutive MOTM: ${stats.consecutiveMOTM}`; 
    }
    if (ach.id === "clean_sheet_5_wins" && stats.consecutiveCleanSheetWins >= 5) { 
      achieved = true; 
      reason = `Consecutive clean sheet wins: ${stats.consecutiveCleanSheetWins}`; 
    }
    if (ach.id === "top_spot_10_matches" && stats.topSpotMatches >= 10) { 
      achieved = true; 
      reason = `Top spot matches: ${stats.topSpotMatches}`; 
    }
    if (ach.id === "consecutive_10_victories" && stats.consecutiveWins >= 10) { 
      achieved = true; 
      reason = `Consecutive wins: ${stats.consecutiveWins}`; 
    }

    if (achieved) {
      console.log(`🏆 ACHIEVEMENT UNLOCKED! User ${userId} - ${ach.definition} (${reason})`);
      await awardXPAchievement(userId, ach.id);
      awarded.push(ach.id);
    } else {
      console.log(`⏳ Achievement '${ach.id}' not yet achieved: ${reason || 'Requirements not met'}`);
    }
  }
  
  if (awarded.length > 0) {
    console.log(`🎉 User ${userId} awarded ${awarded.length} new achievements:`, awarded);
  } else {
    console.log(`📝 User ${userId} - No new achievements awarded`);
  }

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
      // MOTM
      if (motmId === player.id) xp += (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
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
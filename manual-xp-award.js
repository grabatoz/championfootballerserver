// This script manually awards XP for a match
// Usage: node manual-xp-award.js <matchId>

const { Sequelize, Op } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

// XP Points table
const xpPointsTable = {
  winningTeam: 30,
  draw: 15,
  losingTeam: 10,
  motm: { win: 10, lose: 5 },
  cleanSheet: 5,
  goal: { win: 3, lose: 2 },
  assist: { win: 2, lose: 1 },
  motmVote: { win: 2, lose: 1 },
  defensiveImpact: { win: 2, lose: 1 },
  mentality: { win: 2, lose: 2 },
};

async function awardXPForMatch(matchId) {
  console.log(`🏆 Starting XP award for match ${matchId}`);

  // Get match info
  const [matches] = await sequelize.query(`
    SELECT * FROM "Matches" WHERE id = $1
  `, { bind: [matchId] });
  
  if (matches.length === 0) {
    console.log('Match not found');
    return;
  }
  
  const match = matches[0];
  console.log(`Match: Home ${match.homeTeamGoals} - ${match.awayTeamGoals} Away`);

  // Get home and away team users
  const [homeUsers] = await sequelize.query(`
    SELECT u.* FROM "UserHomeMatches" uhm
    JOIN users u ON uhm."userId" = u.id
    WHERE uhm."matchId" = $1
  `, { bind: [matchId] });
  
  const [awayUsers] = await sequelize.query(`
    SELECT u.* FROM "UserAwayMatches" uam
    JOIN users u ON uam."userId" = u.id
    WHERE uam."matchId" = $1
  `, { bind: [matchId] });
  
  console.log(`Home team: ${homeUsers.length} players, Away team: ${awayUsers.length} players`);
  
  // Get all stats
  const [allStats] = await sequelize.query(`
    SELECT * FROM match_statistics WHERE match_id = $1
  `, { bind: [matchId] });
  
  console.log(`Stats records: ${allStats.length}`);
  
  // Get votes
  const [votes] = await sequelize.query(`
    SELECT * FROM "Votes" WHERE "matchId" = $1
  `, { bind: [matchId] });
  
  // Count votes per player
  const voteCounts = {};
  votes.forEach(v => {
    voteCounts[v.votedForId] = (voteCounts[v.votedForId] || 0) + 1;
  });
  
  // Find MOTM
  let motmId = null;
  let maxVotes = 0;
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      motmId = id;
      maxVotes = count;
    }
  });
  console.log(`MOTM: ${motmId} with ${maxVotes} votes`);

  const homeGoals = match.homeTeamGoals || 0;
  const awayGoals = match.awayTeamGoals || 0;
  
  const allPlayers = [...homeUsers, ...awayUsers];
  
  for (const player of allPlayers) {
    let xp = 0;
    const xpBreakdown = [];
    
    const stat = allStats.find(s => s.user_id === player.id);
    const isHome = homeUsers.some(u => u.id === player.id);
    
    // Determine win/draw/lose
    let teamResult = 'lose';
    if (isHome && homeGoals > awayGoals) teamResult = 'win';
    else if (!isHome && awayGoals > homeGoals) teamResult = 'win';
    else if (homeGoals === awayGoals) teamResult = 'draw';
    
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
    if (stat && stat.goals > 0) {
      const goalXP = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
      xp += goalXP;
      xpBreakdown.push(`Goals (${stat.goals}): +${goalXP}`);
    }
    
    // Assists XP
    if (stat && stat.assists > 0) {
      const assistXP = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
      xp += assistXP;
      xpBreakdown.push(`Assists (${stat.assists}): +${assistXP}`);
    }
    
    // Clean sheets
    if (stat && stat.clean_sheets > 0) {
      const csXP = xpPointsTable.cleanSheet * stat.clean_sheets;
      xp += csXP;
      xpBreakdown.push(`Clean Sheets (${stat.clean_sheets}): +${csXP}`);
    }
    
    // MOTM winner
    if (motmId === player.id) {
      const motmXP = teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose;
      xp += motmXP;
      xpBreakdown.push(`MOTM Winner: +${motmXP}`);
    }
    
    // MOTM votes received
    if (voteCounts[player.id]) {
      const voteXP = (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[player.id];
      xp += voteXP;
      xpBreakdown.push(`MOTM Votes (${voteCounts[player.id]}): +${voteXP}`);
    }
    
    // Captain picks - Defensive Impact
    if (match.homeDefensiveImpactId === player.id || match.awayDefensiveImpactId === player.id) {
      const defXP = teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
      xp += defXP;
      xpBreakdown.push(`Defensive Impact: +${defXP}`);
    }
    
    // Captain picks - Mentality
    if (match.homeMentalityId === player.id || match.awayMentalityId === player.id) {
      const menXP = teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
      xp += menXP;
      xpBreakdown.push(`Mentality: +${menXP}`);
    }
    
    console.log(`\n👤 ${player.firstName} ${player.lastName}:`);
    console.log(`   ${xpBreakdown.join(', ')}`);
    console.log(`   Total XP for match: ${xp}`);
    
    // Update match_statistics xp_awarded
    if (stat) {
      await sequelize.query(`
        UPDATE match_statistics SET xp_awarded = $1 WHERE id = $2
      `, { bind: [xp, stat.id] });
      console.log(`   ✅ Updated match_statistics.xp_awarded = ${xp}`);
    }
    
    // Update user total XP
    const oldXP = player.xp || 0;
    const newXP = oldXP + xp;
    await sequelize.query(`
      UPDATE users SET xp = $1 WHERE id = $2
    `, { bind: [newXP, player.id] });
    console.log(`   ✅ Updated user XP: ${oldXP} → ${newXP}`);
  }
  
  console.log('\n✅ XP award complete!');
}

// Get match ID from args or use the recent one
const matchId = process.argv[2] || '6fef420f-9826-4a0a-9735-f16932d4946e';

awardXPForMatch(matchId)
  .catch(err => console.error('Error:', err))
  .finally(() => sequelize.close());

export const xpPointsTable = {
  winningTeam: 30, // Winning Team Bonus
  draw: 15, // Draw
  losingTeam: 10, // Losing Team Consolation
  // motm: removed - only individual votes count via motmVote
  motmVote: { win: 2, lose: 1 }, // Player receiving individual count of votes per match
  cleanSheet: 5, // Clean Sheets (Goalkeeper)
  goal: { win: 3, lose: 2 }, // Goal Scored
  assist: { win: 2, lose: 1 }, // Assist
  defensiveImpact: { win: 2, lose: 1 }, // Defensive Impact (Captain Pick)
  mentality: { win: 2, lose: 2 }, // + Mentality (Captain Pick)
  streak25: 15, // Streak Bonus: 25%
  streak50: 50, // Streak Bonus: 50%
  streak75: 100, // Streak Bonus: 75%
}; 

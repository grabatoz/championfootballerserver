export interface XPAchievement {
  id: string;
  definition: string;
  xp: number;
}


export const xpAchievements: XPAchievement[] = [
  {
    id: "hat_trick_3_matches",
    definition: "Score a hat-trick in 3 consecutive matches in a league",
    xp: 150,
  },
  {
    id: "captain_5_wins",
    definition: "Winning as a captain in 3 matches in a league",
    xp: 200,
  },
  {
    id: "assist_10_consecutive",
    definition: "Assist in 5 consecutive matches in a league",
    xp: 100,
  },
  {
    id: "scoring_10_consecutive",
    definition: "Scoring in 5 consecutive matches in a league",
    xp: 100,
  },
  {
    id: "captain_performance_3",
    definition: "Being voted +Mentality player and/or Defensive Impact 5 matches in a league",
    xp: 200,
  },
  {
    id: "motm_4_consecutive",
    definition: "Winning Man of the Match award 3 times (not votes) in a league",
    xp: 250,
  },
  {
    id: "clean_sheet_5_wins",
    definition: "Keeping 3 clean sheets as a team in a league",
    xp: 300,
  },
  {
    id: "top_spot_10_matches",
    definition: "Playing 90% of matches in a league",
    xp: 400,
  },
  {
    id: "consecutive_10_victories",
    definition: "Winning in 10 consecutive matches in a league",
    xp: 500,
  },
]; 

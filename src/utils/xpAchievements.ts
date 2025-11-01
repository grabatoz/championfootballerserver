export interface XPAchievement {
  id: string;
  definition: string;
  xp: number;
}


export const xpAchievements: XPAchievement[] = [
  {
    id: "hat_trick_3_matches",
    definition: "Scoring 3+ goals in 3 separate matches (Within a single league)",
    xp: 100,
  },
  {
    id: "captain_5_wins",
    definition: "5 wins as captain, leading the team to victory (Across all leagues)",
    xp: 150,
  },
  {
    id: "assist_10_consecutive",
    definition: "Assist in 10 consecutive matches (Within a single league)",
    xp: 200,
  },
  {
    id: "scoring_10_consecutive",
    definition: "Scoring in 10 consecutive matches (Within a single league)",
    xp: 250,
  },
  {
    id: "captain_performance_3",
    definition: "Gets 3 captain's performance pick (Within a single league)",
    xp: 300,
  },
  {
    id: "motm_4_consecutive",
    definition: "4 consecutive 'Man of the Match' performance (Across all leagues)",
    xp: 350,
  },
  {
    id: "clean_sheet_5_wins",
    definition: "5 consecutive wins with clean sheets (Across all leagues)",
    xp: 400,
  },
  {
    id: "top_spot_10_matches",
    definition: "Holding top spot in the league for more than 10 matches",
    xp: 450,
  },
  {
    id: "consecutive_10_victories",
    definition: "Securing 10 consecutive victories in a single league",
    xp: 500,
  },
]; 
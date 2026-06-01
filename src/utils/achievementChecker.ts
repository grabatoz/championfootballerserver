import { xpAchievements } from './xpAchievements';

type Result = 'W' | 'D' | 'L';

export type RewardAchievementId =
  | 'hat_trick_3_matches'
  | 'captain_5_wins'
  | 'assist_10_consecutive'
  | 'scoring_10_consecutive'
  | 'captain_performance_3'
  | 'motm_4_consecutive'
  | 'clean_sheet_5_wins'
  | 'top_spot_10_matches'
  | 'consecutive_10_victories';

export interface AchievementMatchInput {
  id: string;
  leagueId: string;
  homeTeamGoals: number;
  awayTeamGoals: number;
  homeTeamUserIds: string[];
  awayTeamUserIds: string[];
  votePlayerIds: string[];
  homeCaptainId?: string | null;
  awayCaptainId?: string | null;
  homeDefensiveImpactId?: string | null;
  awayDefensiveImpactId?: string | null;
  homeMentalityId?: string | null;
  awayMentalityId?: string | null;
  time: number;
}

export interface AchievementStatLine {
  goals: number;
  assists: number;
}

export interface AchievementBadge {
  id: RewardAchievementId;
  title: string;
  count: number;
  xp: number;
  unlocked: boolean;
  progressText: string;
}

interface MatchSummary {
  goals: number;
  assists: number;
  conceded: number;
  result: Result;
  isCaptainWin: boolean;
  hasXFactorPick: boolean;
  wonMotmAward: boolean;
  cleanSheetTeam: boolean;
}

export interface ComputedAchievementState {
  badges: AchievementBadge[];
  xpAchievementInstances: string[];
  countsById: Record<RewardAchievementId, number>;
}

export interface ComputeAchievementOptions {
  totalMatchesByLeague?: Record<string, number>;
}

const REWARD_ORDER: RewardAchievementId[] = [
  'scoring_10_consecutive',
  'assist_10_consecutive',
  'hat_trick_3_matches',
  'captain_5_wins',
  'captain_performance_3',
  'motm_4_consecutive',
  'clean_sheet_5_wins',
  'top_spot_10_matches',
  'consecutive_10_victories',
];

const REWARD_TITLE: Record<RewardAchievementId, string> = {
  scoring_10_consecutive: 'Goal Rush',
  assist_10_consecutive: 'Pure Magic',
  hat_trick_3_matches: 'Triple Treat',
  captain_5_wins: 'Leader of Legends',
  captain_performance_3: 'The X-Factor',
  motm_4_consecutive: 'Spotlight Star',
  clean_sheet_5_wins: 'Finders Keepers',
  top_spot_10_matches: 'Iron Will',
  consecutive_10_victories: 'Win Streak X',
};

const XP_BY_ID: Record<RewardAchievementId, number> = xpAchievements.reduce((acc, ach) => {
  acc[ach.id as RewardAchievementId] = ach.xp;
  return acc;
}, {} as Record<RewardAchievementId, number>);

const normalizeId = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const comparableId = (value: unknown): string => {
  const id = normalizeId(value);
  return id.startsWith('guest-') ? id.slice(6) : id;
};

const sameComparableId = (a: unknown, b: unknown): boolean => {
  const left = comparableId(a);
  const right = comparableId(b);
  return left !== '' && right !== '' && left === right;
};

const longestStreak = (arr: MatchSummary[], predicate: (m: MatchSummary) => boolean): number => {
  let best = 0;
  let streak = 0;
  for (const item of arr) {
    if (predicate(item)) {
      streak += 1;
      if (streak > best) best = streak;
    } else {
      streak = 0;
    }
  }
  return best;
};

const countStreakCompletions = (
  arr: MatchSummary[],
  predicate: (m: MatchSummary) => boolean,
  target: number
): number => {
  if (target <= 0) return 0;
  let streak = 0;
  let awards = 0;
  for (const item of arr) {
    if (predicate(item)) {
      streak += 1;
      if (streak === target) {
        awards += 1;
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return awards;
};

const buildVoteCounts = (votePlayerIds: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const votedForId of votePlayerIds) {
    const key = comparableId(votedForId);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const getTopMotmWinner = (votePlayerIds: string[]): string => {
  const counts = buildVoteCounts(votePlayerIds);
  let winner = '';
  let maxVotes = 0;
  for (const [playerId, votes] of Object.entries(counts)) {
    if (votes > maxVotes) {
      winner = playerId;
      maxVotes = votes;
    }
  }
  return maxVotes > 0 ? winner : '';
};

export const toAchievementMatchInput = (match: any): AchievementMatchInput => {
  const toNumber = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const toIdArray = (rows: unknown): string[] => {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => normalizeId((row as { id?: unknown })?.id)).filter((id) => id !== '');
  };
  const votes = Array.isArray(match?.votes)
    ? match.votes.map((v: any) => normalizeId(v?.votedForId)).filter((id: string) => id !== '')
    : [];
  const timeValue = match?.date ?? match?.start ?? match?.createdAt ?? match?.updatedAt ?? match?.end ?? 0;
  const ms = new Date(timeValue).getTime();

  return {
    id: normalizeId(match?.id),
    leagueId: normalizeId(match?.leagueId),
    homeTeamGoals: toNumber(match?.homeTeamGoals),
    awayTeamGoals: toNumber(match?.awayTeamGoals),
    homeTeamUserIds: toIdArray(match?.homeTeamUsers),
    awayTeamUserIds: toIdArray(match?.awayTeamUsers),
    votePlayerIds: votes,
    homeCaptainId: normalizeId(match?.homeCaptainId) || null,
    awayCaptainId: normalizeId(match?.awayCaptainId) || null,
    homeDefensiveImpactId: normalizeId(match?.homeDefensiveImpactId) || null,
    awayDefensiveImpactId: normalizeId(match?.awayDefensiveImpactId) || null,
    homeMentalityId: normalizeId(match?.homeMentalityId) || null,
    awayMentalityId: normalizeId(match?.awayMentalityId) || null,
    time: Number.isFinite(ms) ? ms : 0,
  };
};

export const computeAchievementState = (
  userId: string,
  matches: AchievementMatchInput[],
  statsByMatch: Map<string, AchievementStatLine>,
  options?: ComputeAchievementOptions
): ComputedAchievementState => {
  const normalizedUserId = normalizeId(userId);
  const byLeague: Record<string, MatchSummary[]> = {};
  const providedTotals = options?.totalMatchesByLeague;
  const totalMatchesByLeague: Record<string, number> = providedTotals ? { ...providedTotals } : {};

  const sortedMatches = [...matches]
    .filter((m) => normalizeId(m.id) !== '' && normalizeId(m.leagueId) !== '')
    .sort((a, b) => a.time - b.time);

  for (const match of sortedMatches) {
    const leagueId = normalizeId(match.leagueId);
    if (!providedTotals || totalMatchesByLeague[leagueId] === undefined) {
      totalMatchesByLeague[leagueId] = (totalMatchesByLeague[leagueId] || 0) + 1;
    }

    const isHome = match.homeTeamUserIds.some((id) => sameComparableId(id, normalizedUserId));
    const isAway = match.awayTeamUserIds.some((id) => sameComparableId(id, normalizedUserId));
    if (!isHome && !isAway) continue;

    const statLine = statsByMatch.get(normalizeId(match.id)) || { goals: 0, assists: 0 };
    const teamGoals = isHome ? Number(match.homeTeamGoals || 0) : Number(match.awayTeamGoals || 0);
    const oppGoals = isHome ? Number(match.awayTeamGoals || 0) : Number(match.homeTeamGoals || 0);
    const result: Result = teamGoals > oppGoals ? 'W' : teamGoals === oppGoals ? 'D' : 'L';
    const isCaptainWin =
      result === 'W' &&
      (sameComparableId(match.homeCaptainId, normalizedUserId) || sameComparableId(match.awayCaptainId, normalizedUserId));
    const hasXFactorPick =
      sameComparableId(match.homeDefensiveImpactId, normalizedUserId) ||
      sameComparableId(match.awayDefensiveImpactId, normalizedUserId) ||
      sameComparableId(match.homeMentalityId, normalizedUserId) ||
      sameComparableId(match.awayMentalityId, normalizedUserId);
    const motmWinnerId = getTopMotmWinner(match.votePlayerIds);
    const wonMotmAward = sameComparableId(motmWinnerId, normalizedUserId);

    if (!byLeague[leagueId]) byLeague[leagueId] = [];
    byLeague[leagueId].push({
      goals: Number(statLine.goals || 0),
      assists: Number(statLine.assists || 0),
      conceded: oppGoals,
      result,
      isCaptainWin,
      hasXFactorPick,
      wonMotmAward,
      cleanSheetTeam: oppGoals === 0,
    });
  }

  let goalRushCount = 0;
  let goalRushBest = 0;
  let pureMagicCount = 0;
  let pureMagicBest = 0;
  let tripleTreatCount = 0;
  let tripleTreatBest = 0;
  let leaderOfLegendsCount = 0;
  let leaderOfLegendsBest = 0;
  let xFactorCount = 0;
  let xFactorBest = 0;
  let spotlightStarCount = 0;
  let spotlightStarBest = 0;
  let findersKeepersCount = 0;
  let findersKeepersBest = 0;
  let winStreakXCount = 0;
  let winStreakXBest = 0;
  let ironWillCount = 0;
  let ironWillBestPlayed = 0;
  let ironWillBestTotal = 0;
  let ironWillBestPercent = 0;

  for (const [leagueId, arr] of Object.entries(byLeague)) {
    goalRushBest = Math.max(goalRushBest, longestStreak(arr, (m) => m.goals > 0));
    goalRushCount += countStreakCompletions(arr, (m) => m.goals > 0, 5);

    pureMagicBest = Math.max(pureMagicBest, longestStreak(arr, (m) => m.assists > 0));
    pureMagicCount += countStreakCompletions(arr, (m) => m.assists > 0, 5);

    tripleTreatBest = Math.max(tripleTreatBest, longestStreak(arr, (m) => m.goals >= 3));
    tripleTreatCount += countStreakCompletions(arr, (m) => m.goals >= 3, 3);

    const captainWinsInLeague = arr.filter((m) => m.isCaptainWin).length;
    leaderOfLegendsBest = Math.max(leaderOfLegendsBest, captainWinsInLeague);
    leaderOfLegendsCount += Math.floor(captainWinsInLeague / 3);

    const xFactorMatchesInLeague = arr.filter((m) => m.hasXFactorPick).length;
    xFactorBest = Math.max(xFactorBest, xFactorMatchesInLeague);
    xFactorCount += Math.floor(xFactorMatchesInLeague / 5);

    const motmAwardsInLeague = arr.filter((m) => m.wonMotmAward).length;
    spotlightStarBest = Math.max(spotlightStarBest, motmAwardsInLeague);
    spotlightStarCount += Math.floor(motmAwardsInLeague / 3);

    const cleanSheetsInLeague = arr.filter((m) => m.cleanSheetTeam).length;
    findersKeepersBest = Math.max(findersKeepersBest, cleanSheetsInLeague);
    findersKeepersCount += Math.floor(cleanSheetsInLeague / 3);

    winStreakXBest = Math.max(winStreakXBest, longestStreak(arr, (m) => m.result === 'W'));
    winStreakXCount += countStreakCompletions(arr, (m) => m.result === 'W', 10);

    const totalMatchesInLeague = totalMatchesByLeague[leagueId] || 0;
    const playedMatchesInLeague = arr.length;
    if (totalMatchesInLeague > 0) {
      const playedPercent = playedMatchesInLeague / totalMatchesInLeague;
      if (playedPercent >= 0.9) ironWillCount += 1;
      if (
        playedPercent > ironWillBestPercent ||
        (playedPercent === ironWillBestPercent && totalMatchesInLeague > ironWillBestTotal)
      ) {
        ironWillBestPercent = playedPercent;
        ironWillBestPlayed = playedMatchesInLeague;
        ironWillBestTotal = totalMatchesInLeague;
      }
    }
  }

  const badges: AchievementBadge[] = [
    {
      id: 'scoring_10_consecutive',
      title: REWARD_TITLE.scoring_10_consecutive,
      count: goalRushCount,
      xp: XP_BY_ID.scoring_10_consecutive || 0,
      unlocked: goalRushCount > 0,
      progressText: `Best scoring streak in a league: ${goalRushBest}/5`,
    },
    {
      id: 'assist_10_consecutive',
      title: REWARD_TITLE.assist_10_consecutive,
      count: pureMagicCount,
      xp: XP_BY_ID.assist_10_consecutive || 0,
      unlocked: pureMagicCount > 0,
      progressText: `Best assist streak in a league: ${pureMagicBest}/5`,
    },
    {
      id: 'hat_trick_3_matches',
      title: REWARD_TITLE.hat_trick_3_matches,
      count: tripleTreatCount,
      xp: XP_BY_ID.hat_trick_3_matches || 0,
      unlocked: tripleTreatCount > 0,
      progressText: `Best hat-trick streak in a league: ${tripleTreatBest}/3`,
    },
    {
      id: 'captain_5_wins',
      title: REWARD_TITLE.captain_5_wins,
      count: leaderOfLegendsCount,
      xp: XP_BY_ID.captain_5_wins || 0,
      unlocked: leaderOfLegendsCount > 0,
      progressText: `Most captain wins in one league: ${leaderOfLegendsBest}/3`,
    },
    {
      id: 'captain_performance_3',
      title: REWARD_TITLE.captain_performance_3,
      count: xFactorCount,
      xp: XP_BY_ID.captain_performance_3 || 0,
      unlocked: xFactorCount > 0,
      progressText: `Most qualifying matches in one league: ${xFactorBest}/5`,
    },
    {
      id: 'motm_4_consecutive',
      title: REWARD_TITLE.motm_4_consecutive,
      count: spotlightStarCount,
      xp: XP_BY_ID.motm_4_consecutive || 0,
      unlocked: spotlightStarCount > 0,
      progressText: `Most MOTM awards in one league: ${spotlightStarBest}/3`,
    },
    {
      id: 'clean_sheet_5_wins',
      title: REWARD_TITLE.clean_sheet_5_wins,
      count: findersKeepersCount,
      xp: XP_BY_ID.clean_sheet_5_wins || 0,
      unlocked: findersKeepersCount > 0,
      progressText: `Most clean sheets in one league: ${findersKeepersBest}/3`,
    },
    {
      id: 'top_spot_10_matches',
      title: REWARD_TITLE.top_spot_10_matches,
      count: ironWillCount,
      xp: XP_BY_ID.top_spot_10_matches || 0,
      unlocked: ironWillCount > 0,
      progressText:
        ironWillBestTotal > 0
          ? `Best participation in a league: ${ironWillBestPlayed}/${ironWillBestTotal} (${Math.round(
              ironWillBestPercent * 100
            )}%)`
          : 'No completed league matches yet',
    },
    {
      id: 'consecutive_10_victories',
      title: REWARD_TITLE.consecutive_10_victories,
      count: winStreakXCount,
      xp: XP_BY_ID.consecutive_10_victories || 0,
      unlocked: winStreakXCount > 0,
      progressText: `Best win streak in a league: ${winStreakXBest}/10`,
    },
  ];

  const xpAchievementInstances: string[] = [];
  const countsById = {} as Record<RewardAchievementId, number>;
  for (const badge of badges) {
    countsById[badge.id] = badge.count;
    for (let i = 0; i < badge.count; i += 1) {
      xpAchievementInstances.push(badge.id);
    }
  }

  xpAchievementInstances.sort((a, b) => REWARD_ORDER.indexOf(a as RewardAchievementId) - REWARD_ORDER.indexOf(b as RewardAchievementId));

  return { badges, xpAchievementInstances, countsById };
};

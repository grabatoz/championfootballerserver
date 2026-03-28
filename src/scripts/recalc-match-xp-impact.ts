import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';
import { xpPointsTable } from '../utils/xpPointsTable';
import { recalcUserTotalXP } from '../utils/xpRecalc';
import '../models';

type TeamResult = 'win' | 'draw' | 'lose';

type MatchRow = {
  id: string;
  homeTeamGoals: number | null;
  awayTeamGoals: number | null;
  homeDefensiveImpactId: string | null;
  awayDefensiveImpactId: string | null;
  homeMentalityId: string | null;
  awayMentalityId: string | null;
};

type StatRow = {
  id: string;
  userId: string;
  goals: number;
  assists: number;
  cleanSheets: number;
  defence: number;
  impact: number;
  xpAwarded: number;
};

type VoteCountRow = {
  votedForId: string;
  voteCount: number;
};

const clampPercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

async function getTeamUserSets(matchId: string) {
  const homeRows = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" as "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );
  const awayRows = await sequelize.query<{ userId: string }>(
    `SELECT DISTINCT "userId" as "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
    { bind: [matchId], type: QueryTypes.SELECT }
  );
  return {
    home: new Set(homeRows.map(r => String(r.userId))),
    away: new Set(awayRows.map(r => String(r.userId))),
  };
}

function computeTeamResult(userId: string, homeSet: Set<string>, awaySet: Set<string>, homeGoals: number, awayGoals: number): TeamResult {
  const isHome = homeSet.has(String(userId));
  const isAway = awaySet.has(String(userId));

  if (isHome && homeGoals > awayGoals) return 'win';
  if (isAway && awayGoals > homeGoals) return 'win';
  if (homeGoals === awayGoals) return 'draw';
  return 'lose';
}

function computeContributionImpactPercent(params: {
  goals: number;
  assists: number;
  cleanSheets: number;
  defence: number;
  isMentalityPick: boolean;
  teamGoals: number;
}): number {
  const { goals, assists, cleanSheets, defence, isMentalityPick, teamGoals } = params;
  const goalContribution = teamGoals > 0 ? (goals / teamGoals) * 100 : 0;
  const assistContribution = teamGoals > 0 ? (assists / teamGoals) * 50 : 0;
  const cleanSheetContribution = cleanSheets > 0 ? 15 * cleanSheets : 0;
  const defensiveContribution = defence * 10;
  const mentalityContribution = isMentalityPick ? 5 : 0;

  const rawContribution =
    goalContribution +
    assistContribution +
    cleanSheetContribution +
    defensiveContribution +
    mentalityContribution;

  return clampPercentage(rawContribution > 0 ? rawContribution : 15);
}

function computeMatchXp(params: {
  teamResult: TeamResult;
  goals: number;
  assists: number;
  cleanSheets: number;
  voteCount: number;
  isMotmWinner: boolean;
  isDefensivePick: boolean;
  isMentalityPick: boolean;
}): number {
  const {
    teamResult,
    goals,
    assists,
    cleanSheets,
    voteCount,
    isMotmWinner,
    isDefensivePick,
    isMentalityPick,
  } = params;

  let xp = 0;

  // Team result
  if (teamResult === 'win') xp += xpPointsTable.winningTeam;
  else if (teamResult === 'draw') xp += xpPointsTable.draw;
  else xp += xpPointsTable.losingTeam;

  // Goal / Assist (draw follows non-win branch as in controller)
  xp += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * goals;
  xp += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * assists;

  // Clean sheet
  xp += xpPointsTable.cleanSheet * cleanSheets;

  // MOTM votes
  xp += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCount;

  // MOTM winner bonus
  if (isMotmWinner) xp += teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose;

  // Captain picks
  if (isDefensivePick) {
    xp += teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
  }
  if (isMentalityPick) {
    xp += teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
  }

  return Math.max(0, Math.round(xp));
}

async function run() {
  const apply = process.argv.includes('--apply');
  const verbose = process.argv.includes('--verbose');

  console.log(`[recalc-match-xp-impact] Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const matches = await sequelize.query<MatchRow>(
    `
      SELECT
        id,
        COALESCE("homeTeamGoals", 0) as "homeTeamGoals",
        COALESCE("awayTeamGoals", 0) as "awayTeamGoals",
        "homeDefensiveImpactId" as "homeDefensiveImpactId",
        "awayDefensiveImpactId" as "awayDefensiveImpactId",
        "homeMentalityId" as "homeMentalityId",
        "awayMentalityId" as "awayMentalityId"
      FROM "Matches"
    `,
    { type: QueryTypes.SELECT }
  );

  let totalStats = 0;
  let changedRows = 0;
  let changedImpactRows = 0;
  const touchedUsers = new Set<string>();

  for (const match of matches) {
    const matchId = String(match.id);
    const homeGoals = Number(match.homeTeamGoals || 0);
    const awayGoals = Number(match.awayTeamGoals || 0);
    const defensiveIds = new Set(
      [match.homeDefensiveImpactId, match.awayDefensiveImpactId].filter(Boolean).map(String)
    );
    const mentalityIds = new Set(
      [match.homeMentalityId, match.awayMentalityId].filter(Boolean).map(String)
    );

    const teamSets = await getTeamUserSets(matchId);

    const stats = await sequelize.query<StatRow>(
      `
        SELECT
          id,
          user_id as "userId",
          COALESCE(goals, 0) as goals,
          COALESCE(assists, 0) as assists,
          COALESCE(clean_sheets, 0) as "cleanSheets",
          COALESCE(defence, 0) as defence,
          COALESCE(impact, 0) as impact,
          COALESCE(xp_awarded, 0) as "xpAwarded"
        FROM match_statistics
        WHERE match_id = $1
      `,
      { bind: [matchId], type: QueryTypes.SELECT }
    );

    const voteRows = await sequelize.query<VoteCountRow>(
      `
        SELECT
          "votedForId" as "votedForId",
          COUNT(DISTINCT "voterId")::int as "voteCount"
        FROM "Votes"
        WHERE "matchId" = $1
        GROUP BY "votedForId"
      `,
      { bind: [matchId], type: QueryTypes.SELECT }
    );

    const voteMap = new Map<string, number>();
    voteRows.forEach(v => voteMap.set(String(v.votedForId), Number(v.voteCount || 0)));

    // same behavior as controller: pick top vote receiver as MOTM winner
    let motmWinnerId = '';
    let topVotes = -1;
    for (const row of voteRows) {
      const v = Number(row.voteCount || 0);
      if (v > topVotes) {
        topVotes = v;
        motmWinnerId = String(row.votedForId);
      }
    }

    for (const stat of stats) {
      totalStats += 1;
      const userId = String(stat.userId);
      const goals = Math.max(0, Number(stat.goals || 0));
      const assists = Math.max(0, Number(stat.assists || 0));
      const cleanSheets = Math.max(0, Number(stat.cleanSheets || 0));
      const defence = Math.max(0, Number(stat.defence || 0));
      const isHome = teamSets.home.has(userId);
      const isAway = teamSets.away.has(userId);
      const teamGoalsForContribution = isHome
        ? homeGoals
        : isAway
          ? awayGoals
          : Math.max(homeGoals, awayGoals, 0);

      const isMentalityPick = mentalityIds.has(userId);
      const isDefensivePick = defensiveIds.has(userId);
      const voteCount = voteMap.get(userId) || 0;
      const teamResult = computeTeamResult(userId, teamSets.home, teamSets.away, homeGoals, awayGoals);
      const newImpact = computeContributionImpactPercent({
        goals,
        assists,
        cleanSheets,
        defence,
        isMentalityPick,
        teamGoals: teamGoalsForContribution,
      });
      const newXpAwarded = computeMatchXp({
        teamResult,
        goals,
        assists,
        cleanSheets,
        voteCount,
        isMotmWinner: motmWinnerId !== '' && motmWinnerId === userId,
        isDefensivePick,
        isMentalityPick,
      });

      const oldXpAwarded = Number(stat.xpAwarded || 0);
      const oldImpact = Number(stat.impact || 0);
      const xpChanged = oldXpAwarded !== newXpAwarded;
      const impactChanged = oldImpact !== newImpact;

      if (xpChanged || impactChanged) {
        touchedUsers.add(userId);
        changedRows += 1;
        if (impactChanged) changedImpactRows += 1;

        if (verbose) {
          console.log(
            `[${matchId}] user=${userId} xp ${oldXpAwarded} -> ${newXpAwarded}, impact ${oldImpact}% -> ${newImpact}%`
          );
        }

        if (apply) {
          await sequelize.query(
            `
              UPDATE match_statistics
              SET xp_awarded = $1, impact = $2, updated_at = NOW()
              WHERE id = $3
            `,
            { bind: [newXpAwarded, newImpact, stat.id], type: QueryTypes.UPDATE }
          );
        }
      }
    }
  }

  console.log(`[recalc-match-xp-impact] Stats rows scanned: ${totalStats}`);
  console.log(`[recalc-match-xp-impact] Rows needing update: ${changedRows}`);
  console.log(`[recalc-match-xp-impact] Rows with impact update: ${changedImpactRows}`);
  console.log(`[recalc-match-xp-impact] Users impacted: ${touchedUsers.size}`);

  if (apply && touchedUsers.size > 0) {
    console.log('[recalc-match-xp-impact] Recalculating users total XP from match stats + achievements...');
    for (const userId of touchedUsers) {
      await recalcUserTotalXP(userId);
    }
    console.log('[recalc-match-xp-impact] User XP totals recalculated.');
  }

  await sequelize.close();
}

run()
  .then(() => {
    console.log('recalc-match-xp-impact finished');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('recalc-match-xp-impact failed:', err);
    try {
      await sequelize.close();
    } catch {
      // ignore
    }
    process.exit(1);
  });

import models from '../models';
import { Op } from 'sequelize';
import { isGuestUserRecord } from '../utils/playerIdentity';

// Helper functions (exact replication of leagueController.full.ts logic)
const normalizeStatus = (s?: string) => {
  const v = String(s ?? '').toLowerCase();
  if (['result_published', 'result_uploaded', 'uploaded', 'complete', 'finished', 'ended', 'done'].includes(v)) return 'RESULT_PUBLISHED';
  if (['ongoing', 'inprogress', 'in_progress', 'live', 'playing'].includes(v)) return 'ONGOING';
  return 'SCHEDULED';
};

const isGoalkeeperRole = (rawRole: unknown) => {
  const role = String(rawRole || '').trim().toLowerCase();
  return role === 'gk' || role.includes('goalkeeper') || role.includes('keeper');
};

const toDisplayName = (row: any): string => {
  const r = row || {};
  const full = `${String(r.firstName || '').trim()} ${String(r.lastName || '').trim()}`.trim();
  if (full) return full;
  const alt = String(r.displayName || r.name || r.username || '').trim();
  if (alt) return alt;
  const email = String(r.email || '').trim();
  if (email.includes('@')) return email.split('@')[0];
  return '';
};

const parseSnapshot = (raw: any): any => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
};

const toIsoString = (val: any): string | null => {
  if (!val) return null;
  try {
    const d = new Date(val);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
};

type PlayerStats = {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goals: number;
  assists: number;
  motmVotes: number;
  teamGoalsFor: number;
  teamGoalsConceded: number;
  defensiveImpactVotes: number;
  cleanSheets: number;
};

const calcStats = (matches: any[], members: any[]): Record<string, PlayerStats> => {
  const stats: Record<string, PlayerStats> = {};
  const memberIdSet = new Set(
    (members || [])
      .filter((p: any) => !isGuestUserRecord(p))
      .map((p: any) => String(p.id))
  );

  const ensure = (pid: string) => {
    if (!memberIdSet.has(pid)) return;
    if (!stats[pid]) {
      stats[pid] = {
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goals: 0,
        assists: 0,
        motmVotes: 0,
        teamGoalsFor: 0,
        teamGoalsConceded: 0,
        defensiveImpactVotes: 0,
        cleanSheets: 0
      };
    }
  };

  members.forEach((p: any) => ensure(String(p.id)));
  matches.forEach((m: any) => {
    (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
    (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
  });

  matches
    .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
    .forEach((m: any) => {
      const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
      const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));

      [...home, ...away].forEach((pid: string) => {
        if (!stats[pid]) return;
        stats[pid].played++;

        // Add goals, assists and cleanSheets from playerStats
        if (m.playerStats && m.playerStats[pid]) {
          stats[pid].goals += Number(m.playerStats[pid].goals || 0);
          stats[pid].assists += Number(m.playerStats[pid].assists || 0);
          stats[pid].cleanSheets += Number(m.playerStats[pid].cleanSheets || 0);
        }
      });

      // Count MOTM votes
      if (m.manOfTheMatchVotes) {
        Object.values(m.manOfTheMatchVotes).forEach((votedForId: any) => {
          const id = String(votedForId);
          if (stats[id]) stats[id].motmVotes++;
        });
      }

      // Count Defensive Impact votes
      if (m.homeDefensiveImpactId) {
        const id = String(m.homeDefensiveImpactId);
        ensure(id);
        if (stats[id]) stats[id].defensiveImpactVotes++;
      }
      if (m.awayDefensiveImpactId) {
        const id = String(m.awayDefensiveImpactId);
        ensure(id);
        if (stats[id]) stats[id].defensiveImpactVotes++;
      }

      const homeWon = (m.homeTeamGoals ?? 0) > (m.awayTeamGoals ?? 0);
      const awayWon = (m.awayTeamGoals ?? 0) > (m.homeTeamGoals ?? 0);

      home.forEach(pid => {
        if (!stats[pid]) return;
        if (homeWon) stats[pid].wins++;
        else if (awayWon) stats[pid].losses++;
        else stats[pid].draws++;
        stats[pid].teamGoalsFor += m.homeTeamGoals ?? 0;
        stats[pid].teamGoalsConceded += m.awayTeamGoals ?? 0;
      });

      away.forEach(pid => {
        if (!stats[pid]) return;
        if (awayWon) stats[pid].wins++;
        else if (homeWon) stats[pid].losses++;
        else stats[pid].draws++;
        stats[pid].teamGoalsFor += m.awayTeamGoals ?? 0;
        stats[pid].teamGoalsConceded += m.homeTeamGoals ?? 0;
      });
    });

  return stats;
};

async function recalculate() {
  console.log('⚡ Starting global trophy award snapshot recalculation...');
  try {
    const seasons = await models.Season.findAll({
      where: { deleted: false }
    });

    console.log(`Found ${seasons.length} seasons in total. Recalculating...`);
    let updatedCount = 0;

    for (const season of seasons) {
      // Find the associated league with members
      const league = await models.League.findByPk(season.leagueId, {
        include: [
          { model: models.User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'email', 'position', 'positionType', 'xp'] }
        ]
      });

      if (!league) {
        console.log(`⚠️ League not found for season ${season.name} (${season.id}). Skipping.`);
        continue;
      }

      // Fetch season matches
      const matches = await models.Match.findAll({
        where: { seasonId: season.id, deleted: false, status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] } },
        attributes: ['id', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId']
      });

      const plainLeague = league.get({ plain: true }) as any;
      const plainMatches = matches.map(m => m.get({ plain: true }));

      // Fetch match team users, playerStats, and MOTM votes for matches
      const matchIds = plainMatches.map(m => String(m.id));
      if (matchIds.length > 0) {
        const [homeRows, awayRows, matchStatRows, voteRows] = await Promise.all([
          models.User.sequelize!.query(
            `SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds)`,
            { replacements: { matchIds }, type: 'SELECT' as any }
          ),
          models.User.sequelize!.query(
            `SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds)`,
            { replacements: { matchIds }, type: 'SELECT' as any }
          ),
          models.MatchStatistics.findAll({
            where: { match_id: { [Op.in]: matchIds } },
            attributes: ['match_id', 'user_id', 'goals', 'assists', 'cleanSheets'],
            raw: true,
          }),
          models.Vote.findAll({
            where: { matchId: { [Op.in]: matchIds } },
            attributes: ['matchId', 'voterId', 'votedForId'],
            raw: true,
          })
        ]);

        const homeUsersMap = new Map<string, any[]>();
        const awayUsersMap = new Map<string, any[]>();
        const memberMap = new Map((plainLeague.members || []).map((m: any) => [String(m.id), m]));

        homeRows.forEach((r: any) => {
          const mid = String(r.matchId);
          if (!homeUsersMap.has(mid)) homeUsersMap.set(mid, []);
          const u = memberMap.get(String(r.userId));
          if (u) homeUsersMap.get(mid)!.push(u);
        });

        awayRows.forEach((r: any) => {
          const mid = String(r.matchId);
          if (!awayUsersMap.has(mid)) awayUsersMap.set(mid, []);
          const u = memberMap.get(String(r.userId));
          if (u) awayUsersMap.get(mid)!.push(u);
        });

        const psMap: Record<string, Record<string, { goals: number; assists: number; cleanSheets: number }>> = {};
        (matchStatRows || []).forEach((ms: any) => {
          const mid = String(ms.match_id);
          if (!psMap[mid]) psMap[mid] = {};
          const uid = String(ms.user_id);
          const existing = psMap[mid][uid];
          if (existing) {
            existing.goals += Number(ms.goals || 0);
            existing.assists += Number(ms.assists || 0);
            existing.cleanSheets += Number(ms.cleanSheets || 0);
          } else {
            psMap[mid][uid] = {
              goals: Number(ms.goals || 0),
              assists: Number(ms.assists || 0),
              cleanSheets: Number(ms.cleanSheets || 0)
            };
          }
        });

        const motmMap: Record<string, Record<string, string>> = {};
        (voteRows || []).forEach((v: any) => {
          const mid = String(v.matchId);
          if (!motmMap[mid]) motmMap[mid] = {};
          motmMap[mid][String(v.voterId)] = String(v.votedForId);
        });

        plainMatches.forEach((m: any) => {
          const mid = String(m.id);
          m.homeTeamUsers = homeUsersMap.get(mid) || [];
          m.awayTeamUsers = awayUsersMap.get(mid) || [];
          m.playerStats = psMap[mid] || {};
          m.manOfTheMatchVotes = motmMap[mid] || {};
        });
      }

      // Recalculate snapshot if there is an existing snapshot or if we want to build one
      const existingSnapshot = parseSnapshot(season.trophyAwardSnapshot) || {};
      const isCompletedSeason = season.isActive === false || Object.keys(existingSnapshot).length > 0;
      if (!isCompletedSeason) {
        // No snapshot exists, and season isn't complete. Skip so we don't force snapshooting uncompleted seasons
        continue;
      }

      const stats = calcStats(plainMatches, plainLeague.members || []);
      const playerIds = Object.keys(stats).filter(id => stats[id].played > 0);
      const memberXp: Record<string, number> = {};
      (plainLeague.members || []).forEach((p: any) => {
        memberXp[String(p.id)] = Number(p.xp || 0);
      });

      const sortByStandings = (a: string, b: string) => {
        const aPts = stats[a].wins * 3 + stats[a].draws;
        const bPts = stats[b].wins * 3 + stats[b].draws;
        if (bPts !== aPts) return bPts - aPts;

        const aGd = stats[a].teamGoalsFor - stats[a].teamGoalsConceded;
        const bGd = stats[b].teamGoalsFor - stats[b].teamGoalsConceded;
        if (bGd !== aGd) return bGd - aGd;

        if (stats[b].teamGoalsFor !== stats[a].teamGoalsFor) {
          return stats[b].teamGoalsFor - stats[a].teamGoalsFor;
        }
        if (stats[b].wins !== stats[a].wins) return stats[b].wins - stats[a].wins;

        const aXp = memberXp[a] ?? 0;
        const bXp = memberXp[b] ?? 0;
        if (bXp !== aXp) return bXp - aXp;

        return a.localeCompare(b);
      };

      const leagueTable = [...playerIds].sort(sortByStandings);

      let gkIds: string[] = (plainLeague.members || [])
        .filter((p: any) => isGoalkeeperRole(p.positionType || p.position))
        .map((p: any) => String(p.id));

      const gkCandidatesPlayed = gkIds.filter(id => stats[id]?.played > 0 && (stats[id]?.cleanSheets || 0) > 0);
      if (gkCandidatesPlayed.length === 0) {
        // Fallback to all members who have at least one clean sheet
        gkIds = playerIds.filter(id => (stats[id]?.cleanSheets || 0) > 0);
      }

      const cleanSheets: Record<string, number> = {};
      gkIds.forEach(id => {
        cleanSheets[id] = stats[id]?.cleanSheets || 0;
      });

      const nameMap = new Map<string, string>();
      (plainLeague.members || []).forEach((p: any) => {
        const pid = String(p.id);
        const nm = toDisplayName(p);
        if (pid && nm) nameMap.set(pid, nm);
      });
      plainMatches.forEach((m: any) => {
        [...(m.homeTeamUsers || []), ...(m.awayTeamUsers || [])].forEach((u: any) => {
          const pid = String(u.id);
          const nm = toDisplayName(u);
          if (pid && nm && !nameMap.has(pid)) nameMap.set(pid, nm);
        });
      });
      const getPlayerName = (pid: string) => nameMap.get(String(pid)) || '';

      const pickTopBy = (
        ids: string[],
        scorer: (id: string) => number,
        minScore: number = 1
      ): string | null => {
        if (!ids.length) return null;
        const sorted = [...ids].sort((a, b) => scorer(b) - scorer(a));
        const top = sorted[0];
        if (!top) return null;
        return scorer(top) >= minScore ? top : null;
      };

      const awards = [
        { title: 'League Champion', winnerId: leagueTable[0] || null },
        { title: 'Runner-Up', winnerId: leagueTable[1] || null },
        { title: "Ballon D'or", winnerId: pickTopBy(playerIds, (pid) => stats[pid].motmVotes, 1) },
        { title: 'Golden Boot', winnerId: pickTopBy(playerIds, (pid) => stats[pid].goals, 1) },
        { title: 'King Playmaker', winnerId: pickTopBy(playerIds, (pid) => stats[pid].assists, 1) },
        { title: 'Legendary Shield', winnerId: pickTopBy(playerIds, (pid) => stats[pid].defensiveImpactVotes, 1) },
        {
          title: 'Dark Horse',
          winnerId: leagueTable.length > 3
            ? pickTopBy(leagueTable.slice(3), (pid) => stats[pid].motmVotes, 1)
            : null
        },
        {
          title: 'Star Keeper',
          winnerId: (() => {
            const candidates = gkIds.filter(id => stats[id]?.played > 0);
            if (!candidates.length) return null;
            const best = candidates.sort((a, b) => {
              const csA = cleanSheets[a] || 0;
              const csB = cleanSheets[b] || 0;
              if (csB !== csA) return csB - csA;
              const gaA = stats[a]?.teamGoalsConceded ?? Infinity;
              const gaB = stats[b]?.teamGoalsConceded ?? Infinity;
              return gaA - gaB;
            })[0] || null;
            if (!best) return null;
            return (cleanSheets[best] || 0) > 0 ? best : null;
          })()
        }
      ];

      const meetsAwardRequirement = (title: string, winnerId: string | null): boolean => {
        if (!winnerId) return false;
        const s = stats[winnerId];
        if (!s || s.played <= 0) return false;

        switch (title) {
          case 'League Champion':
            return leagueTable.length > 0 && leagueTable[0] === winnerId;
          case 'Runner-Up':
            return leagueTable.length > 1 && leagueTable[1] === winnerId;
          case "Ballon D'or":
            return s.motmVotes > 0;
          case 'Golden Boot':
            return s.goals > 0;
          case 'King Playmaker':
            return s.assists > 0;
          case 'Legendary Shield':
            return s.defensiveImpactVotes > 0;
          case 'Dark Horse':
            return leagueTable.slice(3).includes(winnerId) && s.motmVotes > 0;
          case 'Star Keeper':
            return gkIds.includes(winnerId) && (cleanSheets[winnerId] || 0) > 0;
          default:
            return true;
        }
      };

      const nextSnapshot: any = {};
      const nowIso = new Date().toISOString();

      awards.forEach((award) => {
        const rawWinnerId = award.winnerId ? String(award.winnerId) : null;
        const winnerId = rawWinnerId && meetsAwardRequirement(award.title, rawWinnerId) ? rawWinnerId : null;
        const prev = existingSnapshot[award.title];
        const winnerName = winnerId ? getPlayerName(winnerId) : '';
        const resolvedWinnerName = winnerId
          ? (winnerName || (prev?.winner && prev.winner !== 'TBC' ? prev.winner : 'Player'))
          : 'TBC';
        const hasValidWinner = Boolean(winnerId);
        const prevWinnerId = prev?.winnerId ? String(prev.winnerId) : null;
        const winnerChanged = (hasValidWinner ? winnerId : null) !== prevWinnerId;

        const awardedAt = hasValidWinner
          ? (winnerChanged ? nowIso : (toIsoString(prev?.awardedAt) || toIsoString(prev?.updatedAt) || nowIso))
          : null;
        const updatedAt = winnerChanged ? nowIso : (toIsoString(prev?.updatedAt) || null);

        nextSnapshot[award.title] = {
          winnerId: hasValidWinner ? winnerId : null,
          winner: hasValidWinner ? resolvedWinnerName : 'TBC',
          awardedAt,
          updatedAt,
        };
      });

      // Compare snapshot before and after to decide if we update
      const orderedStr = (snapshot: any) => {
        const ordered: any = {};
        Object.keys(snapshot).sort().forEach(k => {
          ordered[k] = snapshot[k];
        });
        return JSON.stringify(ordered);
      };

      if (orderedStr(existingSnapshot) !== orderedStr(nextSnapshot)) {
        await models.Season.update(
          { trophyAwardSnapshot: nextSnapshot },
          { where: { id: season.id } }
        );
        updatedCount++;
        console.log(`✅ [Snapshots] Recalculated and updated snapshot for season "${season.name}" (League: ${season.leagueId})`);
      }
    }

    console.log(`🏆 Recalculation complete! Total seasons updated: ${updatedCount}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to recalculate snapshots:', err);
    process.exit(1);
  }
}

recalculate();

import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { recalcUserTotalXP } from '../utils/xpRecalc';
import cache from '../utils/cache';

async function run() {
  const apply = process.argv.includes('--apply');
  console.log(`=== Match Statistics Backfill Mode: ${apply ? 'APPLY' : 'DRY-RUN'} ===\n`);

  try {
    // 1. Get all matches
    const matches: any[] = await sequelize.query(`
      SELECT id, "homeTeamGoals", "awayTeamGoals", "leagueId" FROM "Matches"
      WHERE status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
    `, { type: QueryTypes.SELECT });
    console.log(`Total completed matches in DB: ${matches.length}`);

    const matchIds = matches.map(m => String(m.id));
    if (matchIds.length === 0) {
      console.log("No matches found.");
      process.exit(0);
    }

    // 2. Get all lineup entries
    const homeLineups: any[] = await sequelize.query(`
      SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const awayLineups: any[] = await sequelize.query(`
      SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const allLineups: Array<{ matchId: string; userId: string; team: 'home' | 'away' }> = [];
    homeLineups.forEach((l: any) => allLineups.push({ matchId: String(l.matchId), userId: String(l.userId), team: 'home' }));
    awayLineups.forEach((l: any) => allLineups.push({ matchId: String(l.matchId), userId: String(l.userId), team: 'away' }));

    // 3. Get all existing stats
    const stats: any[] = await sequelize.query(`
      SELECT match_id, user_id FROM match_statistics WHERE match_id IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const statsSet = new Set(stats.map((s: any) => `${s.match_id}_${s.user_id}`));

    // Map matches for easy lookup
    const matchMap = new Map(matches.map((m: any) => [String(m.id), m]));

    console.log(`Lineup entries: ${allLineups.length}, Existing stats entries: ${stats.length}`);

    const missingRows: Array<{
      id: string;
      userId: string;
      matchId: string;
      impact: number;
      xpAwarded: number;
    }> = [];
    const insertedUsers = new Set<string>();

    for (const lineup of allLineups) {
      const key = `${lineup.matchId}_${lineup.userId}`;
      if (!statsSet.has(key)) {
        insertedUsers.add(lineup.userId);

        const match = matchMap.get(lineup.matchId);
        if (!match) continue;

        const homeGoals = Number(match.homeTeamGoals || 0);
        const awayGoals = Number(match.awayTeamGoals || 0);
        
        let result: 'win' | 'draw' | 'lose' = 'draw';
        if (homeGoals === awayGoals) {
          result = 'draw';
        } else {
          const isHome = lineup.team === 'home';
          if ((isHome ? homeGoals : awayGoals) > (isHome ? awayGoals : homeGoals)) {
            result = 'win';
          } else {
            result = 'lose';
          }
        }

        let xpAwarded = 10; // Loss consolation
        if (result === 'win') xpAwarded = 30;
        else if (result === 'draw') xpAwarded = 15;

        // Default contribution impact for no goals/assists/defence/mentality is 15%
        const impact = 15;

        missingRows.push({
          id: uuidv4(),
          userId: lineup.userId,
          matchId: lineup.matchId,
          impact,
          xpAwarded
        });
      }
    }

    console.log(`Found ${missingRows.length} missing match_statistics rows.`);

    if (apply && missingRows.length > 0) {
      console.log(`\nInserting ${missingRows.length} rows in batches...`);
      
      const BATCH_SIZE = 500;
      for (let i = 0; i < missingRows.length; i += BATCH_SIZE) {
        const batch = missingRows.slice(i, i + BATCH_SIZE);
        
        // Build batch insert query with ON CONFLICT DO NOTHING to prevent errors if running multiple times
        let query = `
          INSERT INTO match_statistics (
            id, user_id, match_id, goals, assists, clean_sheets, defence, impact,
            penalties, free_kicks, yellow_cards, red_cards, minutes_played, rating,
            xp_awarded, created_at, updated_at
          ) VALUES 
        `;

        const replacements: any = {};
        const valueClauses = batch.map((row, idx) => {
          const idKey = `id_${idx}`;
          const uKey = `u_${idx}`;
          const mKey = `m_${idx}`;
          const iKey = `i_${idx}`;
          const xpKey = `xp_${idx}`;

          replacements[idKey] = row.id;
          replacements[uKey] = row.userId;
          replacements[mKey] = row.matchId;
          replacements[iKey] = row.impact;
          replacements[xpKey] = row.xpAwarded;

          return `(:${idKey}, :${uKey}, :${mKey}, 0, 0, 0, 0, :${iKey}, 0, 0, 0, 0, 90, 6.0, :${xpKey}, NOW(), NOW())`;
        });

        query += valueClauses.join(',\n');
        query += ` ON CONFLICT (user_id, match_id) DO NOTHING`;

        await sequelize.query(query, {
          replacements,
          type: QueryTypes.INSERT
        });
        console.log(`- Inserted batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(missingRows.length / BATCH_SIZE)}`);
      }

      console.log(`\nRecalculating total XP for ${insertedUsers.size} affected users...`);
      let userIdx = 1;
      for (const uId of insertedUsers) {
        await recalcUserTotalXP(uId);
        if (userIdx % 20 === 0 || userIdx === insertedUsers.size) {
          console.log(`- Recalculated ${userIdx}/${insertedUsers.size} users`);
        }
        userIdx++;
      }

      console.log("Recalculation complete. Clearing cache...");
      const rawCache = cache as any;
      if (rawCache && typeof rawCache.flushAll === 'function') {
        rawCache.flushAll();
      } else if (rawCache && typeof rawCache.del === 'function') {
        // Clear common patterns
        const keys = typeof rawCache.keys === 'function' ? rawCache.keys() : [];
        keys.forEach((k: string) => {
          if (k.startsWith('player_profile_') || k.startsWith('user_leagues_')) {
            rawCache.del(k);
          }
        });
      }
      console.log("Cache cleared successfully.");
    } else {
      console.log("Dry-run finished. No data changed.");
    }

  } catch (err) {
    console.error("Error during backfill:", err);
  } finally {
    process.exit(0);
  }
}
run();

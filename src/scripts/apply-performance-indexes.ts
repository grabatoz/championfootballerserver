import sequelize from '../config/database';

async function apply() {
  const q = (sql: string) => sequelize.query(sql);
  console.log('[DB] Applying performance indexes (one-off script)...');
  try {
    // Matches
    await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid ON "Matches"("leagueId");');
    await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid_date ON "Matches"("leagueId", "date" DESC);');

    // Match availability (explicit snake_case table)
    await q('CREATE INDEX IF NOT EXISTS idx_match_availability_match_id ON match_availabilities(match_id);');
    await q('CREATE INDEX IF NOT EXISTS idx_match_availability_user_match ON match_availabilities(user_id, match_id);');

    
    // Home/Away join tables
    await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_matchid ON "UserHomeMatches"("matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_user_match ON "UserHomeMatches"("userId", "matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_matchid ON "UserAwayMatches"("matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_user_match ON "UserAwayMatches"("userId", "matchId");');

  // League membership/admin
  await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_leagueid ON "LeagueMember"("leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_user_league ON "LeagueMember"("userId", "leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_leagueid ON "LeagueAdmin"("leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_user_league ON "LeagueAdmin"("userId", "leagueId");');

    console.log('✅ Performance indexes applied');
  } catch (err) {
    console.error('❌ Failed to apply performance indexes:', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
}

apply();

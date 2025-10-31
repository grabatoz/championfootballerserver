"use strict";

/**
 * Add high-impact indexes used by /auth/data batched queries
 * Postgres only: uses IF NOT EXISTS to avoid errors when re-running.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const q = (sql) => qi.sequelize.query(sql);

    // Matches: lookup by leagueId and sort by date
    await q("CREATE INDEX IF NOT EXISTS idx_matches_leagueid ON \"Matches\"(\"leagueId\");");
    await q("CREATE INDEX IF NOT EXISTS idx_matches_leagueid_date ON \"Matches\"(\"leagueId\", \"date\" DESC);");

  // MatchAvailability: lookups by match_id and user_id (explicit snake_case table)
  await q("CREATE INDEX IF NOT EXISTS idx_match_availability_match_id ON match_availabilities(match_id);");
  await q("CREATE INDEX IF NOT EXISTS idx_match_availability_user_match ON match_availabilities(user_id, match_id);");

    // Home/Away join tables (Sequelize auto through models)
    await q("CREATE INDEX IF NOT EXISTS idx_userhomematches_matchid ON \"UserHomeMatches\"(\"matchId\");");
    await q("CREATE INDEX IF NOT EXISTS idx_userhomematches_user_match ON \"UserHomeMatches\"(\"userId\", \"matchId\");");
    await q("CREATE INDEX IF NOT EXISTS idx_userawaymatches_matchid ON \"UserAwayMatches\"(\"matchId\");");
    await q("CREATE INDEX IF NOT EXISTS idx_userawaymatches_user_match ON \"UserAwayMatches\"(\"userId\", \"matchId\");");

    // League membership/admin join tables
  await q("CREATE INDEX IF NOT EXISTS idx_leaguemember_leagueid ON \"LeagueMember\"(\"leagueId\");");
  await q("CREATE INDEX IF NOT EXISTS idx_leaguemember_user_league ON \"LeagueMember\"(\"userId\", \"leagueId\");");
  await q("CREATE INDEX IF NOT EXISTS idx_leagueadmin_leagueid ON \"LeagueAdmin\"(\"leagueId\");");
  await q("CREATE INDEX IF NOT EXISTS idx_leagueadmin_user_league ON \"LeagueAdmin\"(\"userId\", \"leagueId\");");
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const q = (sql) => qi.sequelize.query(sql);

    await q("DROP INDEX IF EXISTS idx_matches_leagueid;");
    await q("DROP INDEX IF EXISTS idx_matches_leagueid_date;");

    await q("DROP INDEX IF EXISTS idx_match_availability_match_id;");
    await q("DROP INDEX IF EXISTS idx_match_availability_user_match;");

    await q("DROP INDEX IF EXISTS idx_userhomematches_matchid;");
    await q("DROP INDEX IF EXISTS idx_userhomematches_user_match;");
    await q("DROP INDEX IF EXISTS idx_userawaymatches_matchid;");
    await q("DROP INDEX IF EXISTS idx_userawaymatches_user_match;");

    await q("DROP INDEX IF EXISTS idx_leaguemember_leagueid;");
    await q("DROP INDEX IF EXISTS idx_leaguemember_user_league;");
    await q("DROP INDEX IF EXISTS idx_leagueadmin_leagueid;");
    await q("DROP INDEX IF EXISTS idx_leagueadmin_user_league;");
  }
};

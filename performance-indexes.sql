-- Performance optimization SQL for ChampionFootballer database
-- Run these on your PostgreSQL database to speed up queries

-- Index on users table for XP-based queries (world ranking)
CREATE INDEX IF NOT EXISTS idx_users_xp_position ON users(xp DESC, "positionType") WHERE xp > 0;

-- Index on match_statistics for faster leaderboard queries  
CREATE INDEX IF NOT EXISTS idx_match_stats_user_goals ON match_statistics(user_id, goals) WHERE goals > 0;
CREATE INDEX IF NOT EXISTS idx_match_stats_user_assists ON match_statistics(user_id, assists) WHERE assists > 0;
CREATE INDEX IF NOT EXISTS idx_match_stats_user_defence ON match_statistics(user_id, defence) WHERE defence > 0;

-- Composite index for match statistics with match join
CREATE INDEX IF NOT EXISTS idx_match_stats_match_user ON match_statistics(match_id, user_id);

-- Index on matches for league filtering
CREATE INDEX IF NOT EXISTS idx_matches_league_date ON "Matches"("leagueId", date DESC);

-- Index on votes for MOTM leaderboard
CREATE INDEX IF NOT EXISTS idx_votes_match_voted_for ON "Votes"("matchId", "votedForId");

-- Analyze tables to update statistics
ANALYZE users;
ANALYZE match_statistics; 
ANALYZE "Matches";
ANALYZE "Votes";

-- Show index usage stats (run after some queries to verify effectiveness)
-- SELECT schemaname, tablename, indexname, idx_tup_read, idx_tup_fetch 
-- FROM pg_stat_user_indexes 
-- WHERE schemaname = 'public' 
-- ORDER BY idx_tup_read DESC;

-- ULTRA FAST DATABASE OPTIMIZATION SCRIPT
-- Run this on your PostgreSQL database for MAXIMUM SPEED

-- Drop existing indexes first to recreate them optimally
DROP INDEX IF EXISTS idx_users_xp_position;
DROP INDEX IF EXISTS idx_match_stats_user_goals;
DROP INDEX IF EXISTS idx_match_stats_user_assists;
DROP INDEX IF EXISTS idx_match_stats_user_defence;
DROP INDEX IF EXISTS idx_match_stats_match_user;
DROP INDEX IF EXISTS idx_matches_league_date;
DROP INDEX IF EXISTS idx_votes_match_voted_for;

-- ULTRA FAST INDEXES FOR LIGHTNING SPEED
-- Users table - optimized for world ranking queries
CREATE INDEX CONCURRENTLY idx_users_xp_fast ON users(xp DESC NULLS LAST, "positionType") 
WHERE xp > 0 AND "positionType" IS NOT NULL;


-- Match statistics - optimized for leaderboard queries
CREATE INDEX CONCURRENTLY idx_match_stats_user_metrics ON match_statistics(user_id, goals, assists, defence) 
WHERE goals > 0 OR assists > 0 OR defence > 0;

-- Match statistics with match join - for league filtering
CREATE INDEX CONCURRENTLY idx_match_stats_league_fast ON match_statistics(match_id, user_id);

-- Matches - optimized for league and date queries
CREATE INDEX CONCURRENTLY idx_matches_league_fast ON "Matches"("leagueId", date DESC, id);

-- Votes - optimized for MOTM queries
CREATE INDEX CONCURRENTLY idx_votes_motm_fast ON "Votes"("matchId", "votedForId");

-- Composite index for user authentication
CREATE INDEX CONCURRENTLY idx_users_auth_fast ON users(email, "firstName", "lastName") 
WHERE email IS NOT NULL;

-- League members optimization
CREATE INDEX CONCURRENTLY idx_league_members_fast ON league_members("leagueId", "userId");

-- Additional speed optimizations
-- Partial index for active users only
CREATE INDEX CONCURRENTLY idx_users_active ON users(id, "firstName", "lastName", "profilePicture") 
WHERE "deletedAt" IS NULL;

-- Optimize session lookups
CREATE INDEX CONCURRENTLY idx_sessions_fast ON "Sessions"("userId", "expiresAt") 
WHERE "expiresAt" > NOW();

-- Update table statistics for query planner
ANALYZE users;
ANALYZE match_statistics;
ANALYZE "Matches"; 
ANALYZE "Votes";
ANALYZE league_members;
ANALYZE "Sessions";

-- Set aggressive performance parameters (add to postgresql.conf)
-- shared_buffers = 256MB
-- effective_cache_size = 1GB
-- random_page_cost = 1.1
-- seq_page_cost = 1
-- work_mem = 32MB
-- maintenance_work_mem = 128MB

-- Show index usage (run after some queries to verify)
SELECT 
    schemaname,
    tablename, 
    indexname,
    idx_tup_read,
    idx_tup_fetch,
    idx_tup_read + idx_tup_fetch as total_usage
FROM pg_stat_user_indexes 
WHERE schemaname = 'public' 
ORDER BY total_usage DESC;

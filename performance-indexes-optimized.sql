/**
 * Performance optimization indexes for PostgreSQL
 * These indexes significantly improve query performance for common operations
 */

-- ============================================
-- USERS TABLE INDEXES
-- ============================================

-- Index for authentication queries (login, token validation)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email 
ON "Users" (email) 
WHERE deleted_at IS NULL;

-- Index for username lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_username 
ON "Users" (username) 
WHERE deleted_at IS NULL;

-- Index for user search and filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_active 
ON "Users" (active, created_at DESC) 
WHERE deleted_at IS NULL;

-- Composite index for user profile queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_profile 
ON "Users" (id, email, username, active) 
WHERE deleted_at IS NULL;

-- ============================================
-- LEAGUES TABLE INDEXES
-- ============================================

-- Index for league lookups by ID
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leagues_id 
ON "Leagues" (id);

-- Index for invite code lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leagues_invite_code 
ON "Leagues" (invite_code) 
WHERE invite_code IS NOT NULL;

-- Index for active leagues
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leagues_active 
ON "Leagues" (active, created_at DESC) 
WHERE active = true;

-- Index for league admin queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leagues_admin 
ON "Leagues" (admin_id) 
WHERE admin_id IS NOT NULL;

-- Composite index for league listing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leagues_listing 
ON "Leagues" (active, status, created_at DESC);

-- ============================================
-- MATCHES TABLE INDEXES
-- ============================================

-- Index for match lookups by ID
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_id 
ON "Matches" (id);

-- Index for league matches
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_league 
ON "Matches" (league_id, date DESC);

-- Index for active/upcoming matches
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_active 
ON "Matches" (active, status, date DESC) 
WHERE active = true;

-- Index for match status queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_status 
ON "Matches" (status, league_id, date DESC);

-- Composite index for match listing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_listing 
ON "Matches" (league_id, active, status, date DESC);

-- Index for match date range queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_date_range 
ON "Matches" (league_id, date) 
WHERE active = true;

-- ============================================
-- LEAGUE_MEMBERS TABLE INDEXES (Junction)
-- ============================================

-- Index for user's leagues
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_members_user 
ON "LeagueMembers" (user_id, created_at DESC);

-- Index for league's members
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_members_league 
ON "LeagueMembers" (league_id, created_at DESC);

-- Composite unique index to prevent duplicates
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_league_members_unique 
ON "LeagueMembers" (league_id, user_id);

-- ============================================
-- LEAGUE_ADMINISTRATORS TABLE INDEXES
-- ============================================

-- Index for admin's leagues
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_admins_user 
ON "LeagueAdministrators" (user_id);

-- Index for league's admins
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_admins_league 
ON "LeagueAdministrators" (league_id);

-- Composite unique index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_league_admins_unique 
ON "LeagueAdministrators" (league_id, user_id);

-- ============================================
-- MATCH_PARTICIPANTS TABLE INDEXES
-- ============================================

-- Index for user's matches
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participants_user 
ON "MatchParticipants" (user_id);

-- Index for match's participants
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participants_match 
ON "MatchParticipants" (match_id);

-- Index for team assignments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participants_team 
ON "MatchParticipants" (match_id, team);

-- Composite index for participant queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participants_composite 
ON "MatchParticipants" (match_id, user_id, team);

-- ============================================
-- USER_STATISTICS TABLE INDEXES
-- ============================================

-- Index for user stats lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_user 
ON "UserStatistics" (user_id);

-- Index for league stats
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_league 
ON "UserStatistics" (league_id, user_id);

-- Index for leaderboard queries (by XP)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_xp 
ON "UserStatistics" (league_id, total_xp DESC, user_id);

-- Index for win percentage ranking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_win_pct 
ON "UserStatistics" (league_id, win_percentage DESC, matches_played DESC);

-- ============================================
-- PERFORMANCE MAINTENANCE QUERIES
-- ============================================

-- Analyze tables for query planner optimization
ANALYZE "Users";
ANALYZE "Leagues";
ANALYZE "Matches";
ANALYZE "LeagueMembers";
ANALYZE "LeagueAdministrators";
ANALYZE "MatchParticipants";
ANALYZE "UserStatistics";

-- Vacuum to reclaim storage and update statistics
VACUUM ANALYZE "Users";
VACUUM ANALYZE "Leagues";
VACUUM ANALYZE "Matches";

-- ============================================
-- MONITORING QUERIES (Run periodically)
-- ============================================

-- Check index usage
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;

-- Find unused indexes (candidates for removal)
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
    AND idx_scan = 0
    AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Check table sizes
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as indexes_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- ============================================
-- NOTES
-- ============================================
-- 
-- 1. All indexes use CONCURRENTLY to avoid locking tables during creation
-- 2. Partial indexes (WHERE clauses) reduce index size and improve performance
-- 3. Composite indexes support multiple query patterns
-- 4. Regular ANALYZE and VACUUM are essential for maintaining performance
-- 5. Monitor index usage and remove unused indexes to save space
-- 6. Consider index-only scans by including all queried columns in index

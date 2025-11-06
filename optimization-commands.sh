#!/bin/bash

# 🚀 ChampionFootballer API - Database Optimization Commands
# Quick reference for all database optimization tasks

echo "======================================"
echo "🚀 DATABASE OPTIMIZATION COMMANDS"
echo "======================================"
echo ""

# ============================================
# 1. INSTALL INDEXES (MOST IMPORTANT)
# ============================================
echo "📋 Step 1: Install Database Indexes"
echo "------------------------------------"
echo "psql \"your-connection-string\""
echo "\\i COMPREHENSIVE-DB-OPTIMIZATION.sql"
echo "\\q"
echo ""

# ============================================
# 2. CHECK INDEX STATUS
# ============================================
echo "📊 Step 2: Check Indexes Created"
echo "------------------------------------"
echo "psql \"your-connection-string\" -c \"\\di\""
echo ""
echo "Expected: 60+ indexes listed"
echo ""

# ============================================
# 3. ANALYZE TABLES
# ============================================
echo "🔍 Step 3: Update Table Statistics"
echo "------------------------------------"
echo "psql \"your-connection-string\" -c \"ANALYZE;\""
echo ""

# ============================================
# 4. CHECK INDEX USAGE
# ============================================
echo "📈 Step 4: Monitor Index Usage"
echo "------------------------------------"
echo "psql \"your-connection-string\" <<EOF"
echo "SELECT "
echo "    tablename, "
echo "    indexname,"
echo "    idx_scan as scans"
echo "FROM pg_stat_user_indexes "
echo "WHERE schemaname = 'public' "
echo "ORDER BY idx_scan DESC"
echo "LIMIT 20;"
echo "EOF"
echo ""

# ============================================
# 5. WEEKLY MAINTENANCE
# ============================================
echo "🧹 Weekly Maintenance Commands"
echo "------------------------------------"
echo "psql \"your-connection-string\" <<EOF"
echo "VACUUM ANALYZE users;"
echo "VACUUM ANALYZE match_statistics;"
echo "VACUUM ANALYZE \\\"Matches\\\";"
echo "VACUUM ANALYZE \\\"Votes\\\";"
echo "VACUUM ANALYZE \\\"Leagues\\\";"
echo "EOF"
echo ""

# ============================================
# 6. MONTHLY MAINTENANCE
# ============================================
echo "🔧 Monthly Maintenance Commands"
echo "------------------------------------"
echo "psql \"your-connection-string\" -c \"REINDEX DATABASE your_database_name;\""
echo "psql \"your-connection-string\" -c \"ANALYZE;\""
echo ""

# ============================================
# 7. PERFORMANCE TESTING
# ============================================
echo "⚡ Performance Testing"
echo "------------------------------------"
echo "# Test a slow query with EXPLAIN ANALYZE:"
echo "psql \"your-connection-string\" <<EOF"
echo "EXPLAIN ANALYZE"
echo "SELECT * FROM users WHERE xp > 1000 ORDER BY xp DESC LIMIT 10;"
echo "EOF"
echo ""

# ============================================
# 8. RESTART API SERVER
# ============================================
echo "🔄 Restart API Server"
echo "------------------------------------"
echo "cd api"
echo "yarn dev"
echo ""
echo "# Or with PM2:"
echo "pm2 restart all"
echo ""

# ============================================
# 9. COMMON FIXES
# ============================================
echo "🔧 Common Troubleshooting"
echo "------------------------------------"
echo ""
echo "Fix 1: If indexes fail to create:"
echo "  - Remove CONCURRENTLY from CREATE INDEX"
echo "  - Run indexes one by one"
echo ""
echo "Fix 2: If connection pool exhausted:"
echo "  - Increase max pool size in database.ts"
echo "  - Check for connection leaks"
echo ""
echo "Fix 3: If queries still slow:"
echo "  - Run ANALYZE"
echo "  - Check index usage stats"
echo "  - Review query execution plans"
echo ""

# ============================================
# 10. QUICK COMMANDS SUMMARY
# ============================================
echo "======================================"
echo "⚡ QUICK COMMANDS (Copy-Paste)"
echo "======================================"
echo ""
echo "# 1. Install indexes:"
echo "psql \"your-connection-string\" -f COMPREHENSIVE-DB-OPTIMIZATION.sql"
echo ""
echo "# 2. Check indexes:"
echo "psql \"your-connection-string\" -c \"SELECT count(*) FROM pg_indexes WHERE schemaname='public';\""
echo ""
echo "# 3. Analyze:"
echo "psql \"your-connection-string\" -c \"ANALYZE;\""
echo ""
echo "# 4. Test query speed:"
echo "psql \"your-connection-string\" -c \"\\timing\" -c \"SELECT * FROM users LIMIT 10;\""
echo ""
echo "# 5. Restart API:"
echo "cd api && yarn dev"
echo ""

echo "======================================"
echo "✅ READY TO OPTIMIZE!"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. Run the commands above"
echo "2. Test performance in browser"
echo "3. Check logs for any errors"
echo "4. Monitor index usage weekly"
echo ""
echo "🎉 Your API will be 5-10x FASTER!"
echo ""

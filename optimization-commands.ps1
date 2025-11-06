# 🚀 DATABASE OPTIMIZATION - POWERSHELL COMMANDS
# For Windows users (PowerShell)

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "🚀 DATABASE OPTIMIZATION COMMANDS" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ============================================
# 1. INSTALL INDEXES (MOST IMPORTANT)
# ============================================
Write-Host "📋 Step 1: Install Database Indexes" -ForegroundColor Green
Write-Host "------------------------------------"
Write-Host "psql `"your-connection-string`""
Write-Host "\i COMPREHENSIVE-DB-OPTIMIZATION.sql"
Write-Host "\q"
Write-Host ""

# ============================================
# 2. CHECK INDEX STATUS
# ============================================
Write-Host "📊 Step 2: Check Indexes Created" -ForegroundColor Green
Write-Host "------------------------------------"
Write-Host "psql `"your-connection-string`" -c `"\di`""
Write-Host ""
Write-Host "Expected: 60+ indexes listed" -ForegroundColor Yellow
Write-Host ""

# ============================================
# 3. ANALYZE TABLES
# ============================================
Write-Host "🔍 Step 3: Update Table Statistics" -ForegroundColor Green
Write-Host "------------------------------------"
Write-Host "psql `"your-connection-string`" -c `"ANALYZE;`""
Write-Host ""

# ============================================
# 4. QUICK COMMANDS (Copy-Paste Ready)
# ============================================
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "⚡ QUICK COMMANDS (Copy-Paste)" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$commands = @"
# 1. Install indexes (اہم ترین):
psql "your-connection-string" -f COMPREHENSIVE-DB-OPTIMIZATION.sql

# 2. Check indexes count:
psql "your-connection-string" -c "SELECT count(*) FROM pg_indexes WHERE schemaname='public';"

# 3. Analyze tables:
psql "your-connection-string" -c "ANALYZE;"

# 4. Check index usage:
psql "your-connection-string" -c "SELECT tablename, indexname, idx_scan FROM pg_stat_user_indexes WHERE schemaname='public' ORDER BY idx_scan DESC LIMIT 20;"

# 5. Weekly maintenance:
psql "your-connection-string" -c "VACUUM ANALYZE users; VACUUM ANALYZE match_statistics; VACUUM ANALYZE \`"Matches\`";"

# 6. Monthly maintenance:
psql "your-connection-string" -c "REINDEX DATABASE your_database_name; ANALYZE;"

# 7. Restart API:
cd api
yarn dev

# Or with PM2:
pm2 restart all
"@

Write-Host $commands
Write-Host ""

# ============================================
# EXAMPLE CONNECTION STRINGS
# ============================================
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "📝 EXAMPLE CONNECTION STRINGS" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "# Neon DB:" -ForegroundColor Yellow
Write-Host 'psql "postgresql://user:password@host.neon.tech/dbname?sslmode=require"'
Write-Host ""
Write-Host "# Local PostgreSQL:" -ForegroundColor Yellow
Write-Host 'psql "postgresql://postgres:password@localhost:5432/championfootballer"'
Write-Host ""
Write-Host "# Heroku:" -ForegroundColor Yellow
Write-Host 'psql $env:DATABASE_URL'
Write-Host ""

# ============================================
# TESTING PERFORMANCE
# ============================================
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "⚡ TEST PERFORMANCE" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "# Test query speed:" -ForegroundColor Yellow
Write-Host 'psql "your-connection-string" -c "\timing" -c "SELECT * FROM users WHERE xp > 0 ORDER BY xp DESC LIMIT 10;"'
Write-Host ""
Write-Host "Expected: < 50ms (after optimization)" -ForegroundColor Green
Write-Host ""

# ============================================
# TROUBLESHOOTING
# ============================================
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "🔧 TROUBLESHOOTING" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Problem 1: psql command not found" -ForegroundColor Red
Write-Host "Solution: Install PostgreSQL client tools" -ForegroundColor Green
Write-Host "  choco install postgresql" -ForegroundColor White
Write-Host ""
Write-Host "Problem 2: Connection refused" -ForegroundColor Red
Write-Host "Solution: Check .env file for DATABASE_URL" -ForegroundColor Green
Write-Host ""
Write-Host "Problem 3: Indexes fail to create" -ForegroundColor Red
Write-Host "Solution: Remove CONCURRENTLY keyword" -ForegroundColor Green
Write-Host ""

# ============================================
# FINAL CHECKLIST
# ============================================
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "✅ CHECKLIST" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[ ] 1. Install database indexes (SQL file)" -ForegroundColor White
Write-Host "[ ] 2. Run ANALYZE command" -ForegroundColor White
Write-Host "[ ] 3. Restart API server" -ForegroundColor White
Write-Host "[ ] 4. Test in browser (F12 Network tab)" -ForegroundColor White
Write-Host "[ ] 5. Check timing (should be < 200ms)" -ForegroundColor White
Write-Host "[ ] 6. Monitor index usage weekly" -ForegroundColor White
Write-Host ""

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "🎉 READY TO OPTIMIZE!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your API will be 5-10x FASTER! 🚀" -ForegroundColor Yellow
Write-Host ""

# ============================================
# AUTO-RUN OPTION (Uncomment to use)
# ============================================
# Write-Host "Do you want to run optimization now? (Y/N)" -ForegroundColor Yellow
# $response = Read-Host
# if ($response -eq 'Y' -or $response -eq 'y') {
#     Write-Host "Enter your database connection string:" -ForegroundColor Yellow
#     $dbUrl = Read-Host
#     
#     Write-Host "Running optimization..." -ForegroundColor Green
#     psql $dbUrl -f COMPREHENSIVE-DB-OPTIMIZATION.sql
#     
#     Write-Host ""
#     Write-Host "✅ Optimization complete!" -ForegroundColor Green
#     Write-Host "Restart your API server now." -ForegroundColor Yellow
# }

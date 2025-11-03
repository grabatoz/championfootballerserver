#!/bin/bash
# Server Diagnostic & Keep-Alive Script
# Tests all endpoints and keeps server warm

API_URL="${API_URL:-http://localhost:5000}"  # Default to localhost, override with env
INTERVAL=300  # 5 minutes

echo "🔍 ChampionFootballer Server Diagnostics & Keep-Alive"
echo "=================================================="
echo "API URL: $API_URL"
echo "Ping Interval: ${INTERVAL}s ($(($INTERVAL / 60)) minutes)"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to test endpoint
test_endpoint() {
  local endpoint=$1
  local method=${2:-GET}
  local description=$3
  
  echo -n "Testing $description ($method $endpoint)... "
  
  response=$(curl -s -w "\n%{http_code}|%{time_total}" -X $method "$API_URL$endpoint" 2>&1 | tail -1)
  status_code=$(echo $response | cut -d'|' -f1)
  response_time=$(echo $response | cut -d'|' -f2)
  response_time_ms=$(echo "$response_time * 1000" | bc)
  
  if [ "$status_code" = "200" ] || [ "$status_code" = "201" ]; then
    printf "${GREEN}✓ OK${NC} (${status_code}, ${response_time_ms}ms)\n"
    return 0
  elif [ "$status_code" = "401" ] || [ "$status_code" = "403" ]; then
    printf "${YELLOW}⚠ AUTH${NC} (${status_code}, ${response_time_ms}ms)\n"
    return 0
  else
    printf "${RED}✗ FAIL${NC} (${status_code}, ${response_time_ms}ms)\n"
    return 1
  fi
}

# Function to run full diagnostics
run_diagnostics() {
  echo ""
  echo "${BLUE}=== Running Full Server Diagnostics ===${NC}"
  echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
  
  # Health checks
  echo "📊 Health Checks:"
  test_endpoint "/health" "GET" "Basic health"
  test_endpoint "/ping" "GET" "Quick ping"
  test_endpoint "/health/detailed" "GET" "Detailed health"
  test_endpoint "/" "GET" "Root endpoint"
  
  echo ""
  echo "🔐 Auth Endpoints:"
  test_endpoint "/auth/status" "GET" "Auth status"
  
  echo ""
  echo "⚽ Main API Endpoints:"
  test_endpoint "/leagues" "GET" "Leagues list"
  test_endpoint "/matches" "GET" "Matches list"
  test_endpoint "/players" "GET" "Players list"
  test_endpoint "/leaderboard" "GET" "Leaderboard"
  test_endpoint "/world-ranking" "GET" "World ranking"
  
  echo ""
  echo "🔧 Cache & Performance:"
  # Test same endpoint twice to check caching
  echo -n "First request (cache miss)... "
  curl -s -w "%{http_code} in %{time_total}s" -o /dev/null "$API_URL/leagues"
  echo ""
  
  echo -n "Second request (cache hit)... "
  curl -s -w "%{http_code} in %{time_total}s" -o /dev/null "$API_URL/leagues"
  echo ""
  
  echo ""
  echo "💾 Database Connection:"
  health_detailed=$(curl -s "$API_URL/health/detailed")
  if echo "$health_detailed" | grep -q '"connected":true'; then
    echo -e "${GREEN}✓ Database connected${NC}"
  else
    echo -e "${RED}✗ Database connection failed${NC}"
  fi
  
  echo ""
  echo "🧠 Memory Usage:"
  if echo "$health_detailed" | grep -q '"memory"'; then
    memory=$(echo "$health_detailed" | grep -o '"memory":{[^}]*}')
    echo "$memory" | sed 's/[{}]//g' | sed 's/,/\n/g' | sed 's/"//g'
  fi
  
  echo ""
  echo "${BLUE}=== Diagnostics Complete ===${NC}"
  echo ""
}

# Function to keep server alive
keep_alive() {
  while true; do
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Quick ping to keep server warm
    response=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/ping")
    
    if [ "$response" = "200" ]; then
      echo "[$timestamp] ${GREEN}✓${NC} Server alive (HTTP $response)"
    else
      echo "[$timestamp] ${RED}⚠${NC} Server response: HTTP $response"
      # Run full diagnostics on error
      run_diagnostics
    fi
    
    sleep $INTERVAL
  done
}

# Check if diagnostic or keep-alive mode
if [ "$1" = "diagnose" ] || [ "$1" = "-d" ] || [ "$1" = "--diagnose" ]; then
  # Run diagnostics once and exit
  run_diagnostics
elif [ "$1" = "test" ] || [ "$1" = "-t" ] || [ "$1" = "--test" ]; then
  # Quick test
  echo "🔍 Quick Server Test"
  test_endpoint "/health" "GET" "Health"
  test_endpoint "/ping" "GET" "Ping"
  test_endpoint "/leagues" "GET" "Leagues"
else
  # Keep-alive mode (default)
  echo "🚀 Starting Keep-Alive Service"
  echo "Press Ctrl+C to stop"
  echo ""
  
  # Run initial diagnostics
  run_diagnostics
  
  echo "Starting continuous monitoring..."
  echo ""
  
  # Start keep-alive loop
  keep_alive
fi

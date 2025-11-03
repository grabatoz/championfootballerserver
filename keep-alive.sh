#!/bin/bash
# Keep-Alive Script for VPS Server
# Prevents server from going idle/cold

API_URL="https://api.techmanagement.tech/"  # Change to your actual VPS URL

echo "🚀 Starting Keep-Alive Service for $API_URL"
echo "This will ping the server every 5 minutes to keep it warm"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  # Ping health endpoint
  response=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health")
  
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  
  if [ "$response" -eq 200 ]; then
    echo "[$timestamp] ✅ Server is alive (HTTP $response)"
  else
    echo "[$timestamp] ⚠️  Server response: HTTP $response"
    # Try ping endpoint as backup
    curl -s "$API_URL/ping" > /dev/null
  fi
  
  # Wait 5 minutes before next ping
  sleep 300
done

#!/bin/bash
echo "========================================"
echo "ULTRA FAST DEPLOYMENT SCRIPT (Linux)"
echo "========================================"

echo "[1/5] Installing dependencies..."
npm install

echo "[2/5] Building ultra-fast TypeScript..."
npm run build

echo "[3/5] Checking PM2 status..."
pm2 status

echo "[4/5] Restarting API with ultra-fast config..."
pm2 restart championfootballer-api --update-env


echo "[5/5] Checking logs for startup..."
pm2 logs championfootballer-api --lines 20

echo "========================================"
echo "ULTRA FAST DEPLOYMENT COMPLETE!"
echo "API is now running with:"
echo "- 30min aggressive caching"
echo "- Optimized database queries" 
echo "- Limited result sets for speed"
echo "- Cache hit/miss headers"
echo "========================================"

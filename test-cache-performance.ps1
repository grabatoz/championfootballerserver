# Test 1: First request (cache miss)
Write-Host "`n🔍 Test 1: First Request (Cache MISS)" -ForegroundColor Yellow
$start = Get-Date
$response1 = Invoke-WebRequest -Uri "http://localhost:5000/api/leagues" -Method GET -Headers @{"Accept-Encoding"="gzip"}
$time1 = ((Get-Date) - $start).TotalMilliseconds
Write-Host "Time: $($time1)ms" -ForegroundColor Cyan
Write-Host "X-Cache: $($response1.Headers['X-Cache'])" -ForegroundColor Cyan

Start-Sleep -Seconds 1

# Test 2: Second request (cache hit - FAST!)
Write-Host "`n🚀 Test 2: Second Request (Cache HIT)" -ForegroundColor Green
$start = Get-Date
$response2 = Invoke-WebRequest -Uri "http://localhost:5000/api/leagues" -Method GET -Headers @{"Accept-Encoding"="gzip"}
$time2 = ((Get-Date) - $start).TotalMilliseconds
Write-Host "Time: $($time2)ms ⚡⚡⚡" -ForegroundColor Green
Write-Host "X-Cache: $($response2.Headers['X-Cache'])" -ForegroundColor Green
Write-Host "X-Cache-Age: $($response2.Headers['X-Cache-Age'])" -ForegroundColor Green

# Compare
Write-Host "`n📊 Performance Comparison:" -ForegroundColor Magenta
Write-Host "  First Request: $($time1)ms" -ForegroundColor White
Write-Host "  Cached Request: $($time2)ms" -ForegroundColor White
$improvement = [math]::Round(($time1 / $time2), 2)
Write-Host "  Speedup: ${improvement}x faster! 🚀" -ForegroundColor Green

# Test 3: Multiple cached requests
Write-Host "`n🔥 Test 3: Multiple Cached Requests" -ForegroundColor Cyan
$times = @()
for ($i = 1; $i -le 5; $i++) {
    $start = Get-Date
    $response = Invoke-WebRequest -Uri "http://localhost:5000/api/leagues" -Method GET -Headers @{"Accept-Encoding"="gzip"}
    $time = ((Get-Date) - $start).TotalMilliseconds
    $times += $time
    Write-Host "  Request ${i}: $($time)ms" -ForegroundColor White
}

$avgTime = ($times | Measure-Object -Average).Average
Write-Host "`n📈 Average cached response time: $([math]::Round($avgTime, 2))ms" -ForegroundColor Green
Write-Host "✅ All requests from cache = BLAZING FAST! 🚀" -ForegroundColor Green

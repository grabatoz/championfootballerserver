# Simple Server Test Script (PowerShell)
# No special characters - just plain testing

param(
    [string]$ApiUrl = "http://localhost:5000"
)

Write-Host ""
Write-Host "=== ChampionFootballer Server Test ===" -ForegroundColor Cyan
Write-Host "API URL: $ApiUrl"
Write-Host ""

function Test-ServerEndpoint {
    param([string]$Path, [string]$Name, [bool]$RequiresAuth = $false)
    
    Write-Host "Testing $Name... " -NoNewline
    try {
        $response = Invoke-WebRequest -Uri "$ApiUrl$Path" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Host "[OK]" -ForegroundColor Green
            return $true
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($RequiresAuth -and ($statusCode -eq 401 -or $statusCode -eq 403)) {
            Write-Host "[OK-AUTH]" -ForegroundColor Yellow
            return $true
        } else {
            Write-Host "[FAIL]" -ForegroundColor Red
            return $false
        }
    }
}

# Health checks
Write-Host "Health Endpoints:" -ForegroundColor Yellow
Test-ServerEndpoint "/health" "Health check" $false
Test-ServerEndpoint "/ping" "Ping" $false
Test-ServerEndpoint "/" "Root" $false

Write-Host ""
Write-Host "Main API Endpoints (Auth Required):" -ForegroundColor Yellow
Test-ServerEndpoint "/leagues" "Leagues" $true
Test-ServerEndpoint "/matches" "Matches" $true
Test-ServerEndpoint "/players" "Players" $true

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
Write-Host ""

# Server Diagnostic & Keep-Alive Script (PowerShell)
# Tests all endpoints and keeps server warm

param(
    [string]$ApiUrl = "http://localhost:5000",
    [string]$Mode = "keepalive",  # keepalive, diagnose, or test
    [int]$Interval = 300  # seconds (5 minutes)
)

$script:ApiUrl = $ApiUrl
$script:TestResults = @()

function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function Test-Endpoint {
    param(
        [string]$Endpoint,
        [string]$Method = "GET",
        [string]$Description
    )
    
    Write-Host "Testing $Description ($Method $Endpoint)... " -NoNewline
    
    try {
        $url = "$script:ApiUrl$Endpoint"
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        
        $response = Invoke-WebRequest -Uri $url -Method $Method -UseBasicParsing -ErrorAction Stop
        
        $stopwatch.Stop()
        $responseTime = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 2)
        $statusCode = $response.StatusCode
        
        if ($statusCode -eq 200 -or $statusCode -eq 201) {
            Write-ColorOutput "OK ($statusCode, $responseTime ms)" "Green"
            return $true
        } else {
            Write-ColorOutput "WARN ($statusCode, $responseTime ms)" "Yellow"
            return $false
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 401 -or $statusCode -eq 403) {
            Write-ColorOutput "AUTH ($statusCode)" "Yellow"
            return $true
        } else {
            Write-ColorOutput "FAIL ($statusCode)" "Red"
            return $false
        }
    }
}

function Get-ServerHealth {
    try {
        $response = Invoke-RestMethod -Uri "$script:ApiUrl/health/detailed" -Method GET -UseBasicParsing
        return $response
    } catch {
        return $null
    }
}

function Start-FullDiagnostics {
    Write-Host ""
    Write-ColorOutput "=== Running Full Server Diagnostics ===" "Cyan"
    Write-Host "Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host ""
    
    # Health checks
    Write-ColorOutput "📊 Health Checks:" "Cyan"
    Test-Endpoint -Endpoint "/health" -Method "GET" -Description "Basic health"
    Test-Endpoint -Endpoint "/ping" -Method "GET" -Description "Quick ping"
    Test-Endpoint -Endpoint "/health/detailed" -Method "GET" -Description "Detailed health"
    Test-Endpoint -Endpoint "/" -Method "GET" -Description "Root endpoint"
    
    Write-Host ""
    Write-ColorOutput "🔐 Auth Endpoints:" "Cyan"
    Test-Endpoint -Endpoint "/auth/status" -Method "GET" -Description "Auth status"
    
    Write-Host ""
    Write-ColorOutput "⚽ Main API Endpoints:" "Cyan"
    Test-Endpoint -Endpoint "/leagues" -Method "GET" -Description "Leagues list"
    Test-Endpoint -Endpoint "/matches" -Method "GET" -Description "Matches list"
    Test-Endpoint -Endpoint "/players" -Method "GET" -Description "Players list"
    Test-Endpoint -Endpoint "/leaderboard" -Method "GET" -Description "Leaderboard"
    Test-Endpoint -Endpoint "/world-ranking" -Method "GET" -Description "World ranking"
    
    Write-Host ""
    Write-ColorOutput "🔧 Cache & Performance:" "Cyan"
    
    # Test caching
    Write-Host "First request (cache miss)... " -NoNewline
    $sw1 = [System.Diagnostics.Stopwatch]::StartNew()
    $null = Invoke-WebRequest -Uri "$script:ApiUrl/leagues" -UseBasicParsing -ErrorAction SilentlyContinue
    $sw1.Stop()
    Write-Host "$([math]::Round($sw1.Elapsed.TotalMilliseconds, 2))ms"
    
    Write-Host "Second request (cache hit)... " -NoNewline
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    $null = Invoke-WebRequest -Uri "$script:ApiUrl/leagues" -UseBasicParsing -ErrorAction SilentlyContinue
    $sw2.Stop()
    Write-Host "$([math]::Round($sw2.Elapsed.TotalMilliseconds, 2))ms"
    
    # Check if second request was faster
    $improvement = [math]::Round((($sw1.Elapsed.TotalMilliseconds - $sw2.Elapsed.TotalMilliseconds) / $sw1.Elapsed.TotalMilliseconds) * 100, 1)
    if ($improvement -gt 0) {
        Write-ColorOutput "Cache speedup: $improvement%" "Green"
    }
    
    Write-Host ""
    Write-ColorOutput "💾 Database & Memory:" "Cyan"
    $health = Get-ServerHealth
    
    if ($health) {
        if ($health.database.connected) {
            Write-ColorOutput "✓ Database connected" "Green"
        } else {
            Write-ColorOutput "✗ Database disconnected" "Red"
        }
        
        if ($health.memory) {
            Write-Host "Memory used: $($health.memory.used) $($health.memory.unit)"
            Write-Host "Memory total: $($health.memory.total) $($health.memory.unit)"
            
            $memPercent = [math]::Round(($health.memory.used / $health.memory.total) * 100, 1)
            if ($memPercent -gt 80) {
                Write-ColorOutput "⚠ High memory usage: ${memPercent}%" "Yellow"
            } else {
                Write-ColorOutput "✓ Memory usage: ${memPercent}%" "Green"
            }
        }
        
        Write-Host "Server uptime: $([math]::Round($health.uptime / 60, 1)) minutes"
    } else {
        Write-ColorOutput "✗ Could not fetch detailed health" "Red"
    }
    
    Write-Host ""
    Write-ColorOutput "=== Diagnostics Complete ===" "Cyan"
    Write-Host ""
}

function Start-KeepAlive {
    Write-ColorOutput "🚀 Starting Keep-Alive Service" "Green"
    Write-Host "API URL: $script:ApiUrl"
    Write-Host "Ping Interval: $Interval seconds ($([math]::Round($Interval / 60, 1)) minutes)"
    Write-Host "Press Ctrl+C to stop"
    Write-Host ""
    
    # Run initial diagnostics
    Start-FullDiagnostics
    
    Write-ColorOutput "Starting continuous monitoring..." "Cyan"
    Write-Host ""
    
    while ($true) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        
        try {
            $response = Invoke-WebRequest -Uri "$script:ApiUrl/ping" -Method GET -UseBasicParsing -TimeoutSec 10
            
            if ($response.StatusCode -eq 200) {
                Write-Host "[$timestamp] " -NoNewline
                Write-ColorOutput "✓ Server alive (HTTP $($response.StatusCode))" "Green"
            } else {
                Write-Host "[$timestamp] " -NoNewline
                Write-ColorOutput "⚠ Server response: HTTP $($response.StatusCode)" "Yellow"
            }
        } catch {
            Write-Host "[$timestamp] " -NoNewline
            Write-ColorOutput "✗ Server not responding" "Red"
            
            # Run diagnostics on error
            Write-ColorOutput "Running diagnostics..." "Yellow"
            Start-FullDiagnostics
        }
        
        Start-Sleep -Seconds $Interval
    }
}

function Start-QuickTest {
    Write-ColorOutput "🔍 Quick Server Test" "Cyan"
    Write-Host ""
    
    Test-Endpoint -Endpoint "/health" -Method "GET" -Description "Health"
    Test-Endpoint -Endpoint "/ping" -Method "GET" -Description "Ping"
    Test-Endpoint -Endpoint "/leagues" -Method "GET" -Description "Leagues"
    
    Write-Host ""
}

# Main script logic
Write-Host ""
Write-ColorOutput "🔍 ChampionFootballer Server Diagnostics & Keep-Alive" "Cyan"
Write-ColorOutput "================================================" "Cyan"
Write-Host ""

switch ($Mode.ToLower()) {
    "diagnose" {
        Start-FullDiagnostics
    }
    "test" {
        Start-QuickTest
    }
    default {
        Start-KeepAlive
    }
}

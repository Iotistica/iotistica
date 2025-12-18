# Test script to verify anomaly scores are included in sensor payloads
# This script monitors MQTT messages and verifies anomaly_score field is present

Write-Host "=== Anomaly Score Payload Test ===" -ForegroundColor Cyan
Write-Host ""

# Configuration
$mqttBroker = "localhost"
$mqttPort = 5883
$topic = "iot/device/+/endpoints/#"
$duration = 60  # Monitor for 60 seconds

Write-Host "Configuration:" -ForegroundColor Yellow
Write-Host "  MQTT Broker: $mqttBroker`:$mqttPort"
Write-Host "  Topic: $topic"
Write-Host "  Duration: $duration seconds"
Write-Host ""

# Check if mosquitto_sub is available
$mosquittoSub = Get-Command mosquitto_sub -ErrorAction SilentlyContinue
if (-not $mosquittoSub) {
    Write-Host "ERROR: mosquitto_sub not found in PATH" -ForegroundColor Red
    Write-Host "Install mosquitto MQTT client tools to run this test" -ForegroundColor Yellow
    exit 1
}

Write-Host "Starting MQTT subscriber..." -ForegroundColor Green
Write-Host "Listening for sensor messages with anomaly scores..." -ForegroundColor Cyan
Write-Host ""

# Variables to track statistics
$messagesReceived = 0
$messagesWithScores = 0
$readingsWithScores = 0
$totalReadings = 0

# Start mosquitto_sub and parse output
$process = Start-Process -FilePath "mosquitto_sub" -ArgumentList "-h", $mqttBroker, "-p", $mqttPort, "-t", $topic, "-v" -NoNewWindow -PassThru -RedirectStandardOutput "mqtt-output.txt"

# Monitor output for specified duration
$startTime = Get-Date
while (((Get-Date) - $startTime).TotalSeconds -lt $duration) {
    if (Test-Path "mqtt-output.txt") {
        $content = Get-Content "mqtt-output.txt" -Raw -ErrorAction SilentlyContinue
        if ($content) {
            # Clear file for next iteration
            Clear-Content "mqtt-output.txt"
            
            # Parse JSON messages
            $lines = $content -split "`n"
            foreach ($line in $lines) {
                if ($line -match "^\s*\{") {
                    try {
                        $msg = $line | ConvertFrom-Json
                        $messagesReceived++
                        
                        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Message from sensor: $($msg.sensor)" -ForegroundColor White
                        
                        # Check if messages array exists
                        if ($msg.messages) {
                            foreach ($messageStr in $msg.messages) {
                                try {
                                    $data = $messageStr | ConvertFrom-Json
                                    
                                    # Check for readings array
                                    if ($data.readings) {
                                        foreach ($reading in $data.readings) {
                                            $totalReadings++
                                            
                                            $deviceName = $reading.deviceName
                                            $fieldName = if ($reading.registerName) { $reading.registerName } else { $reading.name }
                                            $value = $reading.value
                                            
                                            # Check if anomaly_score is present
                                            if ($null -ne $reading.anomaly_score) {
                                                $readingsWithScores++
                                                $score = [math]::Round($reading.anomaly_score, 3)
                                                
                                                # Color code by score severity
                                                $color = "Green"
                                                if ($score -gt 0.7) { $color = "Red" }
                                                elseif ($score -gt 0.5) { $color = "Yellow" }
                                                
                                                Write-Host "  ✓ $deviceName.$fieldName = $value (score: $score)" -ForegroundColor $color
                                            } else {
                                                Write-Host "  ○ $deviceName.$fieldName = $value (no score)" -ForegroundColor Gray
                                            }
                                        }
                                    }
                                } catch {
                                    # Skip parsing errors
                                }
                            }
                        }
                        
                        if ($readingsWithScores -gt 0) {
                            $messagesWithScores++
                        }
                        
                    } catch {
                        # Skip JSON parsing errors
                    }
                }
            }
        }
    }
    
    Start-Sleep -Milliseconds 500
}

# Stop mosquitto_sub
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Remove-Item "mqtt-output.txt" -Force -ErrorAction SilentlyContinue

# Print summary
Write-Host ""
Write-Host "=== Test Summary ===" -ForegroundColor Cyan
Write-Host "  Messages received: $messagesReceived" -ForegroundColor White
Write-Host "  Messages with anomaly scores: $messagesWithScores" -ForegroundColor White
Write-Host "  Total readings: $totalReadings" -ForegroundColor White
Write-Host "  Readings with scores: $readingsWithScores" -ForegroundColor White

if ($totalReadings -gt 0) {
    $percentage = [math]::Round(($readingsWithScores / $totalReadings) * 100, 1)
    Write-Host "  Coverage: $percentage%" -ForegroundColor $(if ($percentage -gt 50) { "Green" } else { "Yellow" })
}

Write-Host ""

# Determine test result
if ($messagesReceived -eq 0) {
    Write-Host "❌ TEST FAILED: No messages received" -ForegroundColor Red
    Write-Host "   Check that agent is running and MQTT broker is accessible" -ForegroundColor Yellow
    exit 1
}

if ($readingsWithScores -eq 0) {
    Write-Host "⚠ TEST WARNING: No anomaly scores found in messages" -ForegroundColor Yellow
    Write-Host "   Possible causes:" -ForegroundColor Yellow
    Write-Host "   - Anomaly detection not enabled (check features.enableAnomalyDetection)" -ForegroundColor Gray
    Write-Host "   - Metrics not configured (check anomaly.metrics in target state)" -ForegroundColor Gray
    Write-Host "   - Buffer still building (need 10+ samples per metric)" -ForegroundColor Gray
} else {
    Write-Host "✓ TEST PASSED: Anomaly scores found in payload" -ForegroundColor Green
    Write-Host "  Edge AI is enriching sensor data with health scores!" -ForegroundColor Cyan
}

Write-Host ""

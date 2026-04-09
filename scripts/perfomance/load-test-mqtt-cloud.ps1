<#
.SYNOPSIS
    Cloud MQTT ingestion load test for the demo/customer Kubernetes environment.

.DESCRIPTION
    Reuses the local Seam-3 MQTT test flow, but swaps Docker-local discovery for
    Kubernetes and CloudNativePG:

      - tenant ID comes from the namespace license secret
      - active agent UUIDs come from the app database in CNPG
            - MQTT credentials default to the live API runtime MQTT settings
            - publish path targets the external broker endpoint used by agents
            - health polling scrapes the ingestion deployment directly via its local /metrics endpoint

    This keeps the local script intact and provides a cloud-specific workflow for
    namespaces like demo.

.PARAMETER Namespace
    Target customer namespace. Defaults to demo.

.PARAMETER MessageCount
    Total messages to inject. Defaults to 1000.

.PARAMETER AgentCount
    Number of active agents to spread messages across. Defaults to 10.

.PARAMETER MetricsPerMessage
    Number of metric readings inside each DeviceDataEntry. Defaults to 5.

.PARAMETER RatePerSecond
    Target injection rate in messages/sec. 0 = max speed.

.PARAMETER PollIntervalSec
    Health poll interval in seconds. Defaults to 2.

.PARAMETER ApiUrl
    Public API base URL. Defaults to demo-api.iotistica.com.

.PARAMETER JwtToken
    Unused for health polling. Retained for backward compatibility.

.PARAMETER TenantId
    Explicit tenant/customer identifier. When omitted, read from the license secret.

.PARAMETER DatabaseName
    Explicit app database name. When omitted, read from the SQL secret.

.PARAMETER MqttUsername
    Explicit MQTT username. Defaults to admin.

.PARAMETER MqttPassword
    Explicit MQTT password. When omitted, read from the live API runtime env.

.PARAMETER MqttHost
    Explicit MQTT broker host. Defaults to demo-mqtt.iotistica.com.

.PARAMETER MqttPort
    Explicit MQTT broker port. Defaults to 8883.

.PARAMETER MqttUseTls
    Use MQTTS/TLS for publish. Defaults to true.

.PARAMETER MqttInsecureTls
    Skip certificate verification for publish client. Defaults to true.

.PARAMETER ApiDeploymentName
    API deployment used to discover live MQTT runtime credentials. Defaults to demo-iotistic-api.

.PARAMETER IngestionDeploymentName
    Ingestion deployment used to scrape live ingestion metrics. Defaults to demo-iotistic-ingestion.

.PARAMETER MqttPodName
    Explicit Mosquitto pod name. When omitted, discovered by label.

.PARAMETER CnpgNamespace
    CNPG cluster namespace. Defaults to iotistica-cnpg-cl01.

.PARAMETER CnpgPodName
    CNPG primary pod name. Defaults to iotistica-cnpg-cl01-1.

.PARAMETER SqlSecretName
    SQL credentials secret in the target namespace. Defaults to sql-credentials-demo.

.PARAMETER MqttSecretName
    MQTT credentials secret in the target namespace. Defaults to mqtt-credentials-demo.

.PARAMETER LicenseSecretName
    License secret in the target namespace. Defaults to api-license-credentials-demo.

.EXAMPLE
    .\scripts\perfomance\load-test-mqtt-cloud.ps1 -MessageCount 5000 -AgentCount 20

.EXAMPLE
    .\scripts\perfomance\load-test-mqtt-cloud.ps1 -Namespace demo -JwtToken "eyJ..."
#>
[CmdletBinding()]
param(
    [string] $Namespace         = "demo",
    [int]    $MessageCount      = 1000,
    [int]    $AgentCount        = 10,
    [int]    $MetricsPerMessage = 5,
    [int]    $RatePerSecond     = 0,
    [int]    $PollIntervalSec   = 2,
    [string] $ApiUrl            = "https://demo-api.iotistica.com",
    [string] $JwtToken          = "",
    [string] $TenantId          = "",
    [string] $DatabaseName      = "",
    [string] $MqttUsername      = "",
    [string] $MqttPassword      = "",
    [string] $MqttHost          = "demo-mqtt.iotistica.com",
    [int]    $MqttPort          = 8883,
    [bool]   $MqttUseTls        = $true,
    [bool]   $MqttInsecureTls   = $true,
    [string] $ApiDeploymentName = "demo-iotistic-api",
    [string] $IngestionDeploymentName = "demo-iotistic-ingestion",
    [string] $MqttPodName       = "",
    [string] $CnpgNamespace     = "iotistica-cnpg-cl01",
    [string] $CnpgPodName       = "iotistica-cnpg-cl01-1",
    [string] $SqlSecretName     = "sql-credentials-demo",
    [string] $MqttSecretName    = "mqtt-credentials-demo",
    [string] $LicenseSecretName = "api-license-credentials-demo"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Encode-HexId {
    param([string]$Hex)
    $bytes = [byte[]]@(for ($i = 0; $i -lt $Hex.Length; $i += 2) {
        [Convert]::ToByte($Hex.Substring($i, 2), 16)
    })
    ConvertTo-Base64Url $bytes
}

function Encode-TenantIdForTopic {
    param([string]$TenantId)

    if ($TenantId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        return Encode-Uuid $TenantId
    }

    if ($TenantId -match '^[0-9a-f]{12}$') {
        return Encode-HexId $TenantId
    }

    return $TenantId
}

function Encode-Uuid {
    param([string]$Uuid)
    $hex = $Uuid.Replace('-', '')
    $bytes = [byte[]]@(for ($i = 0; $i -lt $hex.Length; $i += 2) {
        [Convert]::ToByte($hex.Substring($i, 2), 16)
    })
    ConvertTo-Base64Url $bytes
}

function Get-DeviceTopic {
    param([string]$EncodedTenant, [string]$EncodedAgent)
    "i/$EncodedTenant/a/$EncodedAgent/endpoints/load-test"
}

function ConvertFrom-Base64StringUtf8 {
    param([string]$Value)
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function ConvertFrom-Base64UrlUtf8 {
    param([string]$Value)
    $base64 = $Value.Replace('-', '+').Replace('_', '/')
    switch ($base64.Length % 4) {
        2 { $base64 += '==' }
        3 { $base64 += '=' }
    }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64))
}

function Normalize-TenantId {
    param([string]$Value)
    $trimmed = $Value.Trim()
    $trimmed = $trimmed -replace '^\{(.+)\}$', '$1'
    $trimmed = $trimmed -replace '^(cust_|tenant_)', ''
    $trimmed
}

function Invoke-KubectlCapture {
    param([string[]]$Arguments)
    $result = & kubectl @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "kubectl $($Arguments -join ' ') failed: $result"
    }

    $text = if ($result -is [System.Array]) {
        ($result -join "`n")
    } else {
        [string]$result
    }

    $cleanLines = @(
        $text -split "`r?`n" |
            Where-Object {
                $_ -and
                $_ -notmatch '^[EWI][0-9]{4}\s+[0-9:.]+\s+\d+\s+.*$'
            }
    )

    ($cleanLines -join "`n").Trim()
}

function Get-SecretValue {
    param(
        [string]$SecretNamespace,
        [string]$SecretName,
        [string]$Key
    )

    $encoded = Invoke-KubectlCapture @(
        'get', 'secret', $SecretName,
        '-n', $SecretNamespace,
        '-o', "jsonpath={.data.$Key}"
    )

    if (-not $encoded) {
        throw "Secret '$SecretName' in namespace '$SecretNamespace' does not contain key '$Key'"
    }

    ConvertFrom-Base64StringUtf8 $encoded
}

function Get-OptionalObjectProperty {
    param(
        [object]$InputObject,
        [string]$PropertyName
    )

    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        return $null
    }

    return [string]$property.Value
}

function Get-OptionalValue {
    param(
        [object]$InputObject,
        [string]$PropertyName
    )

    if ($null -eq $InputObject) {
        return $null
    }

    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-TenantIdFromLicenseSecret {
    param(
        [string]$SecretNamespace,
        [string]$SecretName
    )

    $jwt = Get-SecretValue -SecretNamespace $SecretNamespace -SecretName $SecretName -Key 'key'
    $parts = $jwt.Split('.')
    if ($parts.Length -lt 2) {
        throw "License secret '$SecretName' does not contain a valid JWT"
    }

    $payloadJson = ConvertFrom-Base64UrlUtf8 $parts[1]
    $payload = $payloadJson | ConvertFrom-Json
    $tenantIdFromPayload = Get-OptionalObjectProperty -InputObject $payload -PropertyName 'tenantId'
    $customerIdFromPayload = Get-OptionalObjectProperty -InputObject $payload -PropertyName 'customerId'
    $rawTenantId = if (-not [string]::IsNullOrWhiteSpace($tenantIdFromPayload)) {
        $tenantIdFromPayload
    } else {
        $customerIdFromPayload
    }

    if (-not $rawTenantId) {
        throw "License payload does not contain tenantId or customerId"
    }

    Normalize-TenantId $rawTenantId
}

function Get-MosquittoPodName {
    param([string]$SecretNamespace)

    $podName = Invoke-KubectlCapture @(
        'get', 'pods',
        '-n', $SecretNamespace,
        '-l', 'app.kubernetes.io/component=mosquitto',
        '-o', 'jsonpath={.items[0].metadata.name}'
    )

    if (-not $podName) {
        throw "Could not find a Mosquitto pod in namespace '$SecretNamespace'"
    }

    $podName
}

function Get-ApiRuntimeEnvValue {
    param(
        [string]$DeploymentName,
        [string]$Key
    )

    $raw = Invoke-KubectlCapture @(
        'exec', '-n', $Namespace, "deployment/$DeploymentName",
        '--', 'printenv', $Key
    )

    if (-not $raw) {
        return $null
    }

    return [string]$raw
}

function Invoke-CnpgQuery {
    param(
        [string]$Database,
        [string]$Sql
    )

    Invoke-KubectlCapture @(
        'exec', '-n', $CnpgNamespace, $CnpgPodName,
        '--', 'psql',
        '-U', 'postgres',
        '-d', $Database,
        '-t', '-A',
        '-F', '|',
        '-c', $Sql
    )
}

function ConvertTo-PosixSingleQuoted {
    param([string]$Value)
    "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-PrometheusGaugeValue {
    param(
        [string]$Content,
        [string]$MetricName
    )

    $pattern = "(?m)^" + [Regex]::Escape($MetricName) + "(?:\{[^\}]*\})?\s+([-+0-9.eE]+)\s*$"
    $match = [Regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return $null
    }

    [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-IngestionSnapshotViaIngestionPod {
    param(
        [string]$NamespaceName,
        [string]$DeploymentName
    )

    if ([string]::IsNullOrWhiteSpace($DeploymentName)) {
        throw 'IngestionDeploymentName must be set for health polling'
    }

    $nodeScript = @'
fetch('http://127.0.0.1:3003/metrics')
  .then(async (response) => {
    const text = await response.text();
    if (!response.ok) {
      console.error(`HTTP ${response.status} ${text}`);
      process.exit(1);
    }

    process.stdout.write(text);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
'@

    try {
        $content = Invoke-KubectlCapture @(
            'exec', '-n', $NamespaceName, "deployment/$DeploymentName",
            '--', 'node', '-e', $nodeScript
        )

        if (-not $content) {
            throw "Ingestion metrics scrape returned no content from deployment '$DeploymentName' in namespace '$NamespaceName'"
        }

        $snapshot = [pscustomobject]@{
            streamLength      = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_stream_length'
            workerLag         = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_worker_lag'
            pendingMessages   = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_pending_count'
            dlqLength         = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_dlq_length'
            workerCount       = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_worker_count'
            dwellP95Ms        = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_dwell_latency_p95_ms'
            batchLatP95Ms     = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_batch_latency_p95_ms'
            messagesProcessed = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_messages_processed_total'
            readingsInserted  = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_readings_inserted_total'
            messagesDropped   = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_messages_dropped_total'
        }

        if ($null -eq $snapshot.streamLength -and
            $null -eq $snapshot.workerLag -and
            $null -eq $snapshot.pendingMessages -and
            $null -eq $snapshot.workerCount) {
            throw "Ingestion metrics scrape succeeded but did not return expected iotistic_ingestion_* metrics from deployment '$DeploymentName'"
        }

        return $snapshot
    } catch {
        $message = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { [string]$_ }
        throw "Failed to scrape ingestion metrics from deployment '$DeploymentName' in namespace '$NamespaceName': $message"
    }
}

function Get-IngestionSnapshot {
    Get-IngestionSnapshotViaIngestionPod -NamespaceName $Namespace -DeploymentName $IngestionDeploymentName
}

function Get-HealthValue {
    param(
        [object]$Health,
        [string[]]$Names,
        [object]$Default = $null
    )

    foreach ($name in $Names) {
        $value = Get-OptionalValue -InputObject $Health -PropertyName $name
        if ($null -ne $value) {
            return $value
        }
    }

    return $Default
}

function Get-HealthDeltaValue {
    param(
        [object]$Health,
        [object]$BaselineHealth,
        [string[]]$Names,
        [object]$Default = $null
    )

    $current = Get-HealthValue -Health $Health -Names $Names -Default $null
    if ($null -eq $current) {
        return $Default
    }

    $baseline = Get-HealthValue -Health $BaselineHealth -Names $Names -Default 0

    try {
        return [int64]$current - [int64]$baseline
    } catch {
        return $Default
    }
}

function Write-HealthRow {
    param($Health, $BaselineHealth, [int]$Injected, [int]$Total, [int]$MetricsPerMessage, [double]$ElapsedSec)

    if (-not $Health) {
        throw 'Health snapshot is missing; ingestion metrics scrape must succeed'
    }

    $rate = if ($ElapsedSec -gt 0) { [math]::Round($Injected / $ElapsedSec, 1) } else { 0 }
    $streamLen = Get-HealthValue -Health $Health -Names @('streamLength') -Default '?'
    $workers   = Get-HealthValue -Health $Health -Names @('workerCount', 'workers') -Default '?'
    $lag       = Get-HealthValue -Health $Health -Names @('workerLag', 'lagMs', 'maxDwellMs') -Default '?'
    $processed = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('messagesProcessed') -Default '?'
    $inserted  = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('readingsInserted') -Default '?'
    $dropped   = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('messagesDropped') -Default '?'
    $pending   = Get-HealthValue -Health $Health -Names @('pendingMessages') -Default '?'
    $dwellP95  = Get-HealthValue -Health $Health -Names @('dwellP95Ms') -Default '?'
    $batchP95  = Get-HealthValue -Health $Health -Names @('batchLatP95Ms') -Default '?'

    $droppedValue = 0
    try { $droppedValue = [int]$dropped } catch { $droppedValue = 0 }

    $lagValue = 0
    try { $lagValue = [int]$lag } catch { $lagValue = 0 }

    $droppedColor = if ($droppedValue -gt 0) { 'Red' } else { 'Green' }
    $lagColor = if ($lagValue -gt 20000) { 'Red' } elseif ($lagValue -gt 5000) { 'Yellow' } else { 'Cyan' }
    $injectedReadings = $Injected * $MetricsPerMessage
    $totalReadings = $Total * $MetricsPerMessage

    Write-Host ("{0,8} | msg={1,5}/{2,-5} rd={3,6}/{4,-6} | rate={5,7}/s | stream={6,5} lag=" -f `
        (Get-Date -Format 'HH:mm:ss'), $Injected, $Total, $injectedReadings, $totalReadings, $rate, $streamLen) -NoNewline
    Write-Host ("{0,6}" -f $lag) -ForegroundColor $lagColor -NoNewline
    Write-Host ("  pending={0,5} workers={1,2} procΔ={2,7} insΔ={3,7} dropΔ=" -f `
        $pending, $workers, $processed, $inserted) -NoNewline
    Write-Host ("{0,4}" -f $dropped) -ForegroundColor $droppedColor -NoNewline
    Write-Host ("  dwellP95={0}ms batchP95={1}ms" -f $dwellP95, $batchP95)
}

function Write-FlushRow {
    param(
        [int]$Injected,
        [int]$Total,
        [int]$MetricsPerMessage,
        [double]$ElapsedSec,
        [int]$PendingMessages,
        [int]$TopicCount,
        [string]$Phase
    )

    $rate = if ($ElapsedSec -gt 0) { [math]::Round($Injected / $ElapsedSec, 1) } else { 0 }
    $injectedReadings = $Injected * $MetricsPerMessage
    $totalReadings = $Total * $MetricsPerMessage
    Write-Host ("{0,8} | msg={1,5}/{2,-5} rd={3,6}/{4,-6} | rate={5,7}/s | publishing {6,5} msgs across {7,2} topics | {8}" -f `
        (Get-Date -Format 'HH:mm:ss'), $Injected, $Total, $injectedReadings, $totalReadings, $rate, $PendingMessages, $TopicCount, $Phase) -ForegroundColor DarkGray
}

function Build-EndpointsPayload {
    param(
        [string]$AgentUuid,
        [string]$AgentName,
        [int]$MetricCount,
        [datetime]$BaseTimestamp,
        [int]$Sequence
    )

    $timestamp = $BaseTimestamp.AddMilliseconds($Sequence).ToUniversalTime().ToString('o')
    $metricNames = @('temperature','humidity','pressure','vibration','current','voltage','co2','flow','rpm','power')
    $baseValues  = @{
        temperature = 23.0; humidity = 45.0; pressure = 101.3; vibration = 5.0
        current     = 2.5;  voltage  = 230.0; co2      = 400.0; flow      = 12.5
        rpm         = 1450.0; power  = 575.0
    }
    $units = @{
        temperature = 'C'; humidity = '%'; pressure = 'kPa'; vibration = 'mm/s'
        current     = 'A'; voltage  = 'V'; co2      = 'ppm'; flow      = 'L/min'
        rpm         = 'RPM'; power  = 'W'
    }

    $readings = 1..$MetricCount | ForEach-Object {
        $name = $metricNames[($_ - 1) % $metricNames.Length]
        $base = $baseValues[$name]
        $value = [math]::Round($base + (Get-Random -Minimum -5 -Maximum 5) * 0.1 * $base / 100, 4)
        @{ metric = $name; value = $value; unit = $units[$name]; quality = 'good'; timestamp = $timestamp; protocol = 'mqtt' }
    }

    @{
        deviceName = $AgentName
        timestamp  = $timestamp
        data       = @{
            protocol   = 'mqtt'
            readings   = $readings
            deviceName = $AgentName
            deviceUuid = $AgentUuid
        }
    }
}

function Flush-AllBatchesParallel {
    param(
        [hashtable]$PendingBatches,
        [hashtable]$Topics,
        [string]$User,
        [string]$Pass,
        [string]$BrokerHost,
        [int]$Port,
        [bool]$UseTls,
        [bool]$InsecureTls,
        [string]$PodName,
        [string]$SecretNamespace
    )

    $batches = @($PendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 } | ForEach-Object {
        [pscustomobject]@{ Topic = $Topics[$_.Key]; Lines = $_.Value.ToArray() }
        $_.Value.Clear()
    })
    if ($batches.Count -eq 0) { return }

    $quotedUser = ConvertTo-PosixSingleQuoted $User
    $quotedPass = ConvertTo-PosixSingleQuoted $Pass
    $pod = $PodName
    $ns = $SecretNamespace
    $brokerHost = $BrokerHost
    $port = $Port
    $useTls = $UseTls
    $insecureTls = $InsecureTls

    $batches | ForEach-Object -Parallel {
        $topic = $_.Topic
        $batchPayload = @{
            protocol  = 'mqtt'
            timestamp = (Get-Date).ToUniversalTime().ToString('o')
            messages  = $_.Lines
        } | ConvertTo-Json -Depth 20 -Compress

        $topicQuoted = "'" + $topic.Replace("'", "'\''") + "'"
        $tlsFlags = if ($using:useTls) {
            if ($using:insecureTls) { '--insecure' } else { '' }
        } else {
            ''
        }
        $command = "timeout 30 mosquitto_pub --host $using:brokerHost --port $using:port --username $using:quotedUser --pw $using:quotedPass --topic $topicQuoted --qos 1 $tlsFlags -s"
        $result = $batchPayload | kubectl exec -i -n $using:ns $using:pod -- sh -lc $command 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "mosquitto_pub failed (topic=$topic): $result"
        }
    } -ThrottleLimit 20
}

if (-not $TenantId) {
    Write-Host "Discovering tenant ID from license secret..." -NoNewline
    $TenantId = Get-TenantIdFromLicenseSecret -SecretNamespace $Namespace -SecretName $LicenseSecretName
    Write-Host " $TenantId" -ForegroundColor Green
} else {
    $TenantId = Normalize-TenantId $TenantId
    Write-Host "Using explicit tenant ID: $TenantId" -ForegroundColor Green
}

if (-not $DatabaseName) {
    $DatabaseName = Get-SecretValue -SecretNamespace $Namespace -SecretName $SqlSecretName -Key 'dbname'
}

if (-not $MqttUsername) {
    $MqttUsername = Get-ApiRuntimeEnvValue -DeploymentName $ApiDeploymentName -Key 'MQTT_USERNAME'
}

if (-not $MqttPassword) {
    $MqttPassword = Get-ApiRuntimeEnvValue -DeploymentName $ApiDeploymentName -Key 'MQTT_PASSWORD'
}

if (-not $MqttPassword) {
    $MqttPassword = Get-SecretValue -SecretNamespace $Namespace -SecretName $MqttSecretName -Key 'password'
}

if (-not $MqttPodName) {
    $MqttPodName = Get-MosquittoPodName -SecretNamespace $Namespace
}

$encodedTenant = Encode-TenantIdForTopic $TenantId

$agentRows = Invoke-CnpgQuery -Database $DatabaseName -Sql @"
SELECT uuid::text, COALESCE(name, 'agent-' || LEFT(uuid::text, 8))
FROM agents
WHERE is_active = true
ORDER BY modified_at DESC NULLS LAST, created_at DESC
LIMIT $AgentCount;
"@

$parsedAgents = @()
if ($agentRows) {
    foreach ($row in ($agentRows -split "`n" | Where-Object { $_.Trim() })) {
        $parts = $row.Split('|', 2)
        if ($parts.Length -eq 2 -and $parts[0].Trim() -match '^[0-9a-f-]{36}$') {
            $parsedAgents += [pscustomobject]@{
                Uuid = $parts[0].Trim()
                Name = $parts[1].Trim()
            }
        }
    }
}

if ($parsedAgents.Count -eq 0) {
    throw "No active agents found in database '$DatabaseName' via CNPG pod '$CnpgPodName'"
}

$selectedAgents = @()
for ($i = 0; $i -lt $AgentCount; $i++) {
    $selectedAgents += $parsedAgents[$i % $parsedAgents.Count]
}

$agentTopics = @{}
$agentNames = @{}
foreach ($agent in ($selectedAgents | Group-Object -Property Uuid | ForEach-Object { $_.Group[0] })) {
    $agentNames[$agent.Uuid] = $agent.Name
    $agentTopics[$agent.Uuid] = Get-DeviceTopic -EncodedTenant $encodedTenant -EncodedAgent (Encode-Uuid $agent.Uuid)
}

Write-Host ''
Write-Host '=== Iotistica Cloud MQTT Load Test ===' -ForegroundColor Cyan
Write-Host "  Namespace   : $Namespace"
Write-Host "  CNPG        : $CnpgNamespace / $CnpgPodName / $DatabaseName"
Write-Host "  Publisher   : $MqttPodName (exec pod in namespace $Namespace)"
Write-Host "  Broker      : $(if ($MqttUseTls) { 'mqtts' } else { 'mqtt' })://$MqttHost`:$MqttPort"
Write-Host "  MQTT user   : $MqttUsername"
Write-Host "  Messages    : $MessageCount"
Write-Host "  Agents      : $AgentCount  ($($agentTopics.Count) unique topics; $($parsedAgents.Count) discovered)"
Write-Host "  Metrics/msg : $MetricsPerMessage  ($($MetricsPerMessage * $MessageCount) total readings)"
Write-Host "  Rate target : $(if ($RatePerSecond -gt 0) { "$RatePerSecond msg/s" } else { 'max speed' })"
Write-Host "  API         : $ApiUrl"
Write-Host "  Tenant      : $TenantId  (encoded: $encodedTenant)"
$sampleAgent = $selectedAgents[0]
$sampleTopic = $agentTopics[$sampleAgent.Uuid]
Write-Host "  Topic fmt   : $($sampleTopic -replace (Encode-Uuid $sampleAgent.Uuid), '{encodedAgentUuid}')  (e.g. $sampleTopic)"
$healthPollDesc = 'direct ingestion scrape only'
Write-Host "  Health poll : every ${PollIntervalSec}s — $healthPollDesc"
Write-Host ''

$baselineHealth = Get-IngestionSnapshot

Write-Host ("{0,8} | {1,27} | {2,12} | {3,18} | {4,24} | {5,22}" -f `
    'Time', 'Msgs/Total  Readings/Total', 'rate/stream', 'lag/pending/workers', 'procΔ/insΔ/dropΔ', 'dwellP95/batchP95')
Write-Host ('-' * 130)

$batchSize = 200
$roundSize = $batchSize * $AgentCount
Write-Host "  Flush size  : $roundSize msgs ($batchSize per agent x $AgentCount agents)" -ForegroundColor DarkGray
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$lastPollAt = 0.0
$delayMs = if ($RatePerSecond -gt 0) { [int](1000.0 / $RatePerSecond) } else { 0 }
$injected = 0
$totalPending = 0
$runBaseTimestamp = (Get-Date).ToUniversalTime()

$pendingBatches = @{}
foreach ($uuid in ($selectedAgents.Uuid | Select-Object -Unique)) {
    $pendingBatches[$uuid] = [System.Collections.Generic.List[string]]::new()
}

for ($i = 0; $i -lt $MessageCount; $i++) {
    $agent = $selectedAgents[$i % $AgentCount]
    $payload = Build-EndpointsPayload -AgentUuid $agent.Uuid -AgentName $agent.Name -MetricCount $MetricsPerMessage -BaseTimestamp $runBaseTimestamp -Sequence $i
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    $pendingBatches[$agent.Uuid].Add($json)
    $injected++
    $totalPending++

    if ($totalPending -ge $roundSize) {
        $flushTopicCount = @($pendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 }).Count
        Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages $totalPending -TopicCount $flushTopicCount -Phase 'flush start'
        Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -User $MqttUsername -Pass $MqttPassword -BrokerHost $MqttHost -Port $MqttPort -UseTls $MqttUseTls -InsecureTls $MqttInsecureTls -PodName $MqttPodName -SecretNamespace $Namespace
        $totalPending = 0

        $elapsedSec = $stopwatch.Elapsed.TotalSeconds
        Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec -PendingMessages 0 -TopicCount $flushTopicCount -Phase 'flush done'

        if (($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
            $health = Get-IngestionSnapshot
            Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec
            $lastPollAt = $elapsedSec
        }
    }

    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }

    $elapsedSec = $stopwatch.Elapsed.TotalSeconds
    if ($totalPending -eq 0 -and ($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
        $health = Get-IngestionSnapshot
        Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec
        $lastPollAt = $elapsedSec
    }
}

if ($totalPending -gt 0) {
    $flushTopicCount = @($pendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 }).Count
    Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages $totalPending -TopicCount $flushTopicCount -Phase 'final flush start'
}
Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -User $MqttUsername -Pass $MqttPassword -BrokerHost $MqttHost -Port $MqttPort -UseTls $MqttUseTls -InsecureTls $MqttInsecureTls -PodName $MqttPodName -SecretNamespace $Namespace

if ($totalPending -gt 0) {
    Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages 0 -TopicCount $flushTopicCount -Phase 'final flush done'
}

$stopwatch.Stop()
$totalSec = $stopwatch.Elapsed.TotalSeconds
$actualRate = [math]::Round($MessageCount / $totalSec, 1)
$totalReadings = $MessageCount * $MetricsPerMessage

Write-Host ''
Write-Host '=== Injection complete ===' -ForegroundColor Cyan
Write-Host ("  Injected : {0} messages ({1} readings) in {2:F2}s = {3} msg/s actual" -f `
    $MessageCount, $totalReadings, $totalSec, $actualRate)

Write-Host ''
Write-Host 'Waiting for worker to drain stream (lag=0, pending=0)...' -ForegroundColor Yellow
$drainTimeout = [System.Diagnostics.Stopwatch]::StartNew()
while ($drainTimeout.Elapsed.TotalSeconds -lt 120) {
    Start-Sleep -Seconds $PollIntervalSec
    $health = Get-IngestionSnapshot
    Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec ($totalSec + $drainTimeout.Elapsed.TotalSeconds)

    if ($health) {
        $lag = [int](Get-HealthValue -Health $health -Names @('workerLag', 'lagMs', 'maxDwellMs') -Default -1)
        $pending = [int](Get-HealthValue -Health $health -Names @('pendingMessages') -Default -1)
        if ($lag -eq 0 -and $pending -eq 0) {
            Write-Host ''
            Write-Host 'Worker caught up (lag=0, pending=0).' -ForegroundColor Green
            break
        }
    }
}

Write-Host ''
Write-Host '=== Final Stats ===' -ForegroundColor Cyan
$finalHealth = Get-IngestionSnapshot
if ($finalHealth) {
    $processed = Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('messagesProcessed') -Default '?'
    $inserted = Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('readingsInserted') -Default '?'
    $dropped = Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('messagesDropped') -Default '?'
    $lag = Get-HealthValue -Health $finalHealth -Names @('workerLag', 'lagMs', 'maxDwellMs') -Default '?'
    $pending = Get-HealthValue -Health $finalHealth -Names @('pendingMessages') -Default '?'
    $dlq = Get-HealthValue -Health $finalHealth -Names @('dlqLength') -Default '?'
    Write-Host ("  Consumer lag    : {0}  pending: {1}" -f $lag, $pending)
    Write-Host ("  Processed (run) : {0}" -f $processed)
    Write-Host ("  Readings (run)  : {0}" -f $inserted)
    $droppedNumeric = 0
    try { $droppedNumeric = [int]$dropped } catch { $droppedNumeric = 0 }
    $droppedColor = if ($droppedNumeric -gt 0) { 'Red' } else { 'Green' }
    Write-Host ("  Dropped (run)   : {0}" -f $dropped) -ForegroundColor $droppedColor
    Write-Host ("  DLQ length      : {0}" -f $dlq)
} else {
    Write-Host '  Could not retrieve final health snapshot.' -ForegroundColor DarkGray
}

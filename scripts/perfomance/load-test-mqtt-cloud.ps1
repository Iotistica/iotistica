<#
.SYNOPSIS
    Cloud MQTT ingestion load test for the demo/customer Kubernetes environment.

.DESCRIPTION
    Reuses the local Seam-3 MQTT test flow, but swaps Docker-local discovery for
    Kubernetes and CloudNativePG:

      - tenant ID comes from the namespace license secret
      - active agent UUIDs come from the app database in CNPG
            - MQTT credentials default to the live API runtime MQTT settings
            - publish path uses long-lived mqtt.js sessions with agent-style client IDs
            - publisher connections target the external broker endpoint used by agents
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

.PARAMETER MqttClientIdPrefix
    Optional client ID prefix. When omitted, uses device_<agentUuid> like the agent default.

.PARAMETER MqttCleanSession
    MQTT clean session flag. Defaults to true to match the agent's cloud manager default.

.PARAMETER MqttKeepAliveSec
    MQTT keepalive interval in seconds. Defaults to 60 to match the agent's cloud manager default.

.PARAMETER MqttReconnectPeriodMs
    MQTT reconnect period in milliseconds. Defaults to 5000 to match the agent's cloud manager default.

.PARAMETER MqttConnectTimeoutMs
    MQTT connect timeout in milliseconds. Defaults to 30000 to match the agent's cloud manager default.

.PARAMETER UseSyntheticAgents
    Generate synthetic agent UUIDs instead of reusing active agents from the database.

.PARAMETER RegisterSyntheticAgents
    Insert synthetic agents into the agents table for the duration of the test.

.PARAMETER DisposeAfterRun
    Delete readings and anomalies for synthetic agents after the run, and remove inserted agent rows when applicable.

.PARAMETER TestRunId
    Optional run identifier used in synthetic agent names for traceability.

.PARAMETER MqttPodName
    Retained for backward compatibility. No longer used by the publisher path.

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
    [string] $MqttClientIdPrefix = "",
    [bool]   $MqttCleanSession  = $true,
    [int]    $MqttKeepAliveSec  = 60,
    [int]    $MqttReconnectPeriodMs = 5000,
    [int]    $MqttConnectTimeoutMs = 30000,
    [bool]   $MqttUseTls        = $true,
    [bool]   $MqttInsecureTls   = $true,
    [switch] $UseSyntheticAgents,
    [switch] $RegisterSyntheticAgents,
    [switch] $DisposeAfterRun,
    [string] $TestRunId         = "",
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

$script:CnpgResolvedPrimaryPodName = $null
$script:CnpgResolvedClusterName = $null

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

function Get-CnpgClusterName {
    if ($script:CnpgResolvedClusterName) {
        return $script:CnpgResolvedClusterName
    }

    if ($CnpgPodName -match '^(.*)-\d+$') {
        $script:CnpgResolvedClusterName = $Matches[1]
        return $script:CnpgResolvedClusterName
    }

    $clusterName = Invoke-KubectlCapture @(
        'get', 'cluster.postgresql.cnpg.io',
        '-n', $CnpgNamespace,
        '-o', 'jsonpath={.items[0].metadata.name}'
    )

    if (-not $clusterName) {
        throw "Could not determine CNPG cluster name in namespace '$CnpgNamespace'"
    }

    $script:CnpgResolvedClusterName = $clusterName
    return $script:CnpgResolvedClusterName
}

function Get-CnpgWritablePodName {
    param([switch]$Refresh)

    if (-not $Refresh -and $script:CnpgResolvedPrimaryPodName) {
        return $script:CnpgResolvedPrimaryPodName
    }

    $clusterName = Get-CnpgClusterName
    $primaryPod = Invoke-KubectlCapture @(
        'get', 'cluster.postgresql.cnpg.io', $clusterName,
        '-n', $CnpgNamespace,
        '-o', 'jsonpath={.status.currentPrimary}'
    )

    if (-not $primaryPod) {
        $primaryPod = Invoke-KubectlCapture @(
            'get', 'pods',
            '-n', $CnpgNamespace,
            '-l', "cnpg.io/cluster=$clusterName,cnpg.io/instanceRole=primary",
            '-o', 'jsonpath={.items[0].metadata.name}'
        )
    }

    if (-not $primaryPod) {
        throw "Could not determine writable CNPG primary pod for cluster '$clusterName' in namespace '$CnpgNamespace'"
    }

    $script:CnpgResolvedPrimaryPodName = $primaryPod
    return $script:CnpgResolvedPrimaryPodName
}

function Invoke-CnpgQuery {
    param(
        [string]$Database,
        [string]$Sql
    )

    $targetPod = Get-CnpgWritablePodName

    try {
        return Invoke-KubectlCapture @(
            'exec', '-n', $CnpgNamespace, $targetPod,
            '--', 'psql',
            '-U', 'postgres',
            '-d', $Database,
            '-t', '-A',
            '-F', '|',
            '-c', $Sql
        )
    } catch {
        $message = $_.Exception.Message
        if ($message -match 'read-only transaction|cannot execute .* in a read-only transaction') {
            $targetPod = Get-CnpgWritablePodName -Refresh
            return Invoke-KubectlCapture @(
                'exec', '-n', $CnpgNamespace, $targetPod,
                '--', 'psql',
                '-U', 'postgres',
                '-d', $Database,
                '-t', '-A',
                '-F', '|',
                '-c', $Sql
            )
        }

        throw
    }
}

function New-RequestId {
    [guid]::NewGuid().ToString('N')
}

function Get-AgentStyleClientId {
    param(
        [string]$AgentUuid,
        [string]$ClientIdPrefix
    )

    if (-not [string]::IsNullOrWhiteSpace($ClientIdPrefix)) {
        return "${ClientIdPrefix}_$AgentUuid"
    }

    return "device_$AgentUuid"
}

function ConvertTo-SqlLiteral {
    param([string]$Value)
    if ($null -eq $Value) {
        return 'NULL'
    }

    return "'" + $Value.Replace("'", "''") + "'"
}

function ConvertTo-SqlUuidList {
    param([string[]]$Values)
    (@($Values | ForEach-Object { "$(ConvertTo-SqlLiteral $_)::uuid" }) -join ', ')
}

function ConvertTo-SqlTextList {
    param([string[]]$Values)
    (@($Values | ForEach-Object { ConvertTo-SqlLiteral $_ }) -join ', ')
}

function New-SyntheticAgents {
    param(
        [int]$Count,
        [string]$RunId
    )

    $agents = @()
    for ($index = 1; $index -le $Count; $index++) {
        $agents += [pscustomobject]@{
            Uuid = [guid]::NewGuid().ToString()
            Name = ('perf-{0}-{1:d4}' -f $RunId, $index)
        }
    }

    return $agents
}

function Register-SyntheticAgents {
    param(
        [string]$Database,
        [object[]]$Agents,
        [string]$ClientIdPrefix
    )

    if ($Agents.Count -eq 0) {
        return
    }

    $values = @($Agents | ForEach-Object {
        $clientId = Get-AgentStyleClientId -AgentUuid $_.Uuid -ClientIdPrefix $ClientIdPrefix
        "($(ConvertTo-SqlLiteral $_.Uuid)::uuid, $(ConvertTo-SqlLiteral $_.Name), 'virtual', true, 'idle', $(ConvertTo-SqlLiteral $clientId))"
    })

    $sql = @"
INSERT INTO agents (uuid, name, type, is_active, status, mqtt_client_id)
VALUES
  $($values -join ",`n  ")
ON CONFLICT (uuid) DO NOTHING;
"@

    Invoke-CnpgQuery -Database $Database -Sql $sql | Out-Null
}

function Remove-SyntheticTestData {
    param(
        [string]$Database,
        [object[]]$Agents,
        [bool]$RemoveAgentRows
    )

    if ($Agents.Count -eq 0) {
        return
    }

    $uuids = @($Agents | ForEach-Object { $_.Uuid } | Select-Object -Unique)
    $uuidList = ConvertTo-SqlUuidList -Values $uuids
    $textList = ConvertTo-SqlTextList -Values $uuids

    $deleteAgentRowsSql = if ($RemoveAgentRows) {
        "DELETE FROM agents WHERE uuid IN ($uuidList);"
    } else {
        ''
    }

    $sql = @"
DELETE FROM anomaly_events WHERE agent_uuid IN ($textList);
DELETE FROM readings WHERE agent_uuid IN ($uuidList);
$deleteAgentRowsSql
"@

    Invoke-CnpgQuery -Database $Database -Sql $sql | Out-Null
}

function Read-MqttPublisherMessage {
    param(
        [pscustomobject]$Publisher,
        [string]$ExpectedRequestId,
        [string]$Phase
    )

    while ($true) {
        $line = $Publisher.Process.StandardOutput.ReadLine()
        if ($null -eq $line) {
            $stderr = $Publisher.Process.StandardError.ReadToEnd()
            throw "MQTT publisher helper exited during $Phase. $stderr"
        }

        $message = $line | ConvertFrom-Json
        if ($message.type -eq 'log') {
            $color = switch ($message.level) {
                'error' { 'Red' }
                'warn' { 'Yellow' }
                default { 'DarkGray' }
            }

            Write-Host ("[publisher] {0} ({1})" -f $message.message, $message.clientId) -ForegroundColor $color
            continue
        }

        if ($message.type -eq 'ready') {
            if ($ExpectedRequestId) {
                continue
            }

            return $message
        }

        if ($message.type -eq 'response') {
            if ($ExpectedRequestId -and $message.requestId -ne $ExpectedRequestId) {
                continue
            }

            if (-not $message.ok) {
                throw "MQTT publisher helper $Phase failed: $($message.error)"
            }

            return $message
        }
    }
}

function Start-MqttPublisherProcess {
    param(
        [string]$BrokerHost,
        [int]$Port,
        [bool]$UseTls,
        [bool]$InsecureTls,
        [string]$Username,
        [string]$Password,
        [bool]$CleanSession,
        [int]$KeepAliveSec,
        [int]$ReconnectPeriodMs,
        [int]$ConnectTimeoutMs,
        [object[]]$Agents,
        [string]$ClientIdPrefix
    )

    $helperPath = Join-Path $PSScriptRoot 'mqtt-persistent-publisher.cjs'
    $brokerScheme = if ($UseTls) { 'mqtts' } else { 'mqtt' }
    $config = [ordered]@{
        brokerUrl = "${brokerScheme}://$BrokerHost`:$Port"
        username = $Username
        password = $Password
        cleanSession = $CleanSession
        keepAlive = $KeepAliveSec
        reconnectPeriod = $ReconnectPeriodMs
        connectTimeout = $ConnectTimeoutMs
        rejectUnauthorized = -not $InsecureTls
        agents = @($Agents | ForEach-Object {
            [ordered]@{
                agentUuid = $_.Uuid
                clientId = Get-AgentStyleClientId -AgentUuid $_.Uuid -ClientIdPrefix $ClientIdPrefix
                topic = $_.Topic
            }
        })
    }

    $configJson = $config | ConvertTo-Json -Depth 10 -Compress
    $configBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($configJson))

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'node'
    $startInfo.ArgumentList.Add($helperPath)
    $startInfo.ArgumentList.Add('--config')
    $startInfo.ArgumentList.Add($configBase64)
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = (Split-Path $helperPath -Parent)

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
        throw 'Failed to start MQTT publisher helper process'
    }

    $publisher = [pscustomobject]@{
        Process = $process
        Writer = $process.StandardInput
        IsStopped = $false
    }

    $ready = Read-MqttPublisherMessage -Publisher $publisher -ExpectedRequestId '' -Phase 'startup'
    Write-Host ("Publisher helper ready with {0} persistent client(s)" -f $ready.clientCount) -ForegroundColor DarkGray
    return $publisher
}

function Invoke-MqttPublisherCommand {
    param(
        [pscustomobject]$Publisher,
        [string]$Command,
        [object]$Payload
    )

    $requestId = New-RequestId
    $commandPayload = [ordered]@{
        command = $Command
        requestId = $requestId
    }

    if ($Payload) {
        foreach ($property in $Payload.PSObject.Properties) {
            $commandPayload[$property.Name] = $property.Value
        }
    }

    $Publisher.Writer.WriteLine(($commandPayload | ConvertTo-Json -Depth 20 -Compress))
    $Publisher.Writer.Flush()
    Read-MqttPublisherMessage -Publisher $Publisher -ExpectedRequestId $requestId -Phase $Command
}

function Stop-MqttPublisherProcess {
    param([pscustomobject]$Publisher)

    if ($null -eq $Publisher) {
        return
    }

    if ($Publisher.IsStopped) {
        return
    }

    $Publisher.IsStopped = $true

    try {
        if (-not $Publisher.Process.HasExited) {
            Invoke-MqttPublisherCommand -Publisher $Publisher -Command 'shutdown' -Payload ([pscustomobject]@{}) | Out-Null
        }
    } finally {
        try {
            $Publisher.Writer.Dispose()
        } catch {
        }

        try {
            if (-not $Publisher.Process.HasExited) {
                $Publisher.Process.WaitForExit(5000) | Out-Null
            }
        } catch {
        }

        try {
            $Publisher.Process.Dispose()
        } catch {
        }
    }
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
        [pscustomobject]$Publisher
    )

    $batches = @($PendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 } | ForEach-Object {
        [pscustomobject]@{ AgentUuid = $_.Key; Topic = $Topics[$_.Key]; Lines = $_.Value.ToArray() }
        $_.Value.Clear()
    })
    if ($batches.Count -eq 0) { return }

    $payload = [pscustomobject]@{
        batches = @($batches | ForEach-Object {
            [ordered]@{
                agentUuid = $_.AgentUuid
                topic = $_.Topic
                payload = (@{
                    protocol  = 'mqtt'
                    timestamp = (Get-Date).ToUniversalTime().ToString('o')
                    messages  = $_.Lines
                } | ConvertTo-Json -Depth 20 -Compress)
            }
        })
    }

    Invoke-MqttPublisherCommand -Publisher $Publisher -Command 'publish' -Payload $payload | Out-Null
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

if ($RegisterSyntheticAgents -and -not $UseSyntheticAgents) {
    throw 'RegisterSyntheticAgents requires UseSyntheticAgents'
}

if ($DisposeAfterRun -and -not $UseSyntheticAgents) {
    throw 'DisposeAfterRun is only supported with UseSyntheticAgents to avoid deleting real agent data'
}

if ($UseSyntheticAgents -and [string]::IsNullOrWhiteSpace($TestRunId)) {
    $TestRunId = Get-Date -Format 'yyyyMMddHHmmss'
}

$encodedTenant = Encode-TenantIdForTopic $TenantId
$resolvedCnpgPodName = Get-CnpgWritablePodName

$parsedAgents = @()
$selectedAgents = @()
$syntheticAgentsRegistered = $false

$agentRows = Invoke-CnpgQuery -Database $DatabaseName -Sql @"
SELECT uuid::text, COALESCE(name, 'agent-' || LEFT(uuid::text, 8))
FROM agents
WHERE is_active = true
ORDER BY modified_at DESC NULLS LAST, created_at DESC
LIMIT $AgentCount;
"@

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

if ($UseSyntheticAgents) {
    $selectedAgents = @(New-SyntheticAgents -Count $AgentCount -RunId $TestRunId)
    if ($RegisterSyntheticAgents) {
        Register-SyntheticAgents -Database $DatabaseName -Agents $selectedAgents -ClientIdPrefix $MqttClientIdPrefix
        $syntheticAgentsRegistered = $true
    }
} else {
    if ($parsedAgents.Count -eq 0) {
        throw "No active agents found in database '$DatabaseName' via CNPG pod '$CnpgPodName'"
    }

    for ($i = 0; $i -lt $AgentCount; $i++) {
        $selectedAgents += $parsedAgents[$i % $parsedAgents.Count]
    }
}

$agentTopics = @{}
$agentNames = @{}
foreach ($agent in ($selectedAgents | Group-Object -Property Uuid | ForEach-Object { $_.Group[0] })) {
    $agentNames[$agent.Uuid] = $agent.Name
    $agentTopics[$agent.Uuid] = Get-DeviceTopic -EncodedTenant $encodedTenant -EncodedAgent (Encode-Uuid $agent.Uuid)
}

$publisherAgents = @($selectedAgents | Group-Object -Property Uuid | ForEach-Object {
    $agent = $_.Group[0]
    [pscustomobject]@{
        Uuid = $agent.Uuid
        Name = $agent.Name
        Topic = $agentTopics[$agent.Uuid]
    }
})

$mqttPublisher = $null

Write-Host ''
Write-Host '=== Iotistica Cloud MQTT Load Test ===' -ForegroundColor Cyan
Write-Host "  Namespace   : $Namespace"
Write-Host "  CNPG        : $CnpgNamespace / $resolvedCnpgPodName / $DatabaseName"
Write-Host "  Publisher   : local persistent mqtt.js clients ($($publisherAgents.Count) simulated agents)"
Write-Host "  Agent mode  : $(if ($UseSyntheticAgents) { if ($RegisterSyntheticAgents) { 'synthetic + registered in DB' } else { 'synthetic only (no DB rows)' } } else { 'reuse active DB agents' })"
Write-Host "  Broker      : $(if ($MqttUseTls) { 'mqtts' } else { 'mqtt' })://$MqttHost`:$MqttPort"
Write-Host "  MQTT user   : $MqttUsername"
Write-Host "  Client IDs  : $(if ([string]::IsNullOrWhiteSpace($MqttClientIdPrefix)) { 'device_<agentUuid>' } else { "$MqttClientIdPrefix`_<agentUuid>" })"
Write-Host "  Session     : clean=$MqttCleanSession keepalive=${MqttKeepAliveSec}s reconnect=${MqttReconnectPeriodMs}ms timeout=${MqttConnectTimeoutMs}ms"
Write-Host "  Messages    : $MessageCount"
Write-Host "  Agents      : $AgentCount  ($($agentTopics.Count) unique topics; $($parsedAgents.Count) discovered)"
Write-Host "  Metrics/msg : $MetricsPerMessage  ($($MetricsPerMessage * $MessageCount) total readings)"
Write-Host "  Rate target : $(if ($RatePerSecond -gt 0) { "$RatePerSecond msg/s" } else { 'max speed' })"
Write-Host "  API         : $ApiUrl"
Write-Host "  Tenant      : $TenantId  (encoded: $encodedTenant)"
$sampleAgent = $selectedAgents[0]
$sampleTopic = $agentTopics[$sampleAgent.Uuid]
Write-Host "  Topic fmt   : $($sampleTopic -replace (Encode-Uuid $sampleAgent.Uuid), '{encodedAgentUuid}')  (e.g. $sampleTopic)"
if ($UseSyntheticAgents) {
    Write-Host "  Synthetic run: $TestRunId" -ForegroundColor DarkGray
}
$healthPollDesc = 'direct ingestion scrape only'
Write-Host "  Health poll : every ${PollIntervalSec}s — $healthPollDesc"
Write-Host ''

try {
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

    $mqttPublisher = Start-MqttPublisherProcess -BrokerHost $MqttHost -Port $MqttPort -UseTls $MqttUseTls -InsecureTls $MqttInsecureTls -Username $MqttUsername -Password $MqttPassword -CleanSession $MqttCleanSession -KeepAliveSec $MqttKeepAliveSec -ReconnectPeriodMs $MqttReconnectPeriodMs -ConnectTimeoutMs $MqttConnectTimeoutMs -Agents $publisherAgents -ClientIdPrefix $MqttClientIdPrefix

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
            Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -Publisher $mqttPublisher
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
    Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -Publisher $mqttPublisher

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
} finally {
    Stop-MqttPublisherProcess -Publisher $mqttPublisher

    if ($DisposeAfterRun -and $UseSyntheticAgents) {
        Write-Host ''
        Write-Host 'Disposing synthetic test data...' -ForegroundColor Yellow
        Remove-SyntheticTestData -Database $DatabaseName -Agents $selectedAgents -RemoveAgentRows $syntheticAgentsRegistered
        Write-Host 'Synthetic test data removed.' -ForegroundColor Green
    }
}

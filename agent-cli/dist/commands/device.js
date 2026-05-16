"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showStatusEnhanced = showStatusEnhanced;
exports.bufferStatus = bufferStatus;
exports.memoryDiagnostics = memoryDiagnostics;
exports.restart = restart;
exports.runDiagnostics = runDiagnostics;
exports.agentUpdate = agentUpdate;
const fs_1 = require("fs");
const undici_1 = require("undici");
const core_1 = require("../core");
const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_WAIT_TIMEOUT_MS = 60000;
function summarizeRestartState(state, ready) {
    switch (state) {
        case 'STOPPING':
            return 'Stopping runtime services';
        case 'STOPPED':
            return 'Runtime services stopped, waiting to reinitialize';
        case 'INIT':
            return 'Initializing core services';
        case 'READY':
            return 'Core initialization complete';
        case 'RUNNING':
            return ready ? 'Restart complete' : 'Final readiness checks still running';
        case 'ERROR':
            return 'Restart entered error state';
        default:
            return ready ? 'Restart in progress, agent reports ready' : 'Restart in progress';
    }
}
async function waitForRestartCompletion(initialState) {
    const startedAt = Date.now();
    let lastState = initialState;
    let lastReady;
    let sawTransition = false;
    while (Date.now() - startedAt < RESTART_WAIT_TIMEOUT_MS) {
        const readiness = await (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/readiness`);
        const state = readiness.data?.state || readiness.data?.lifecycleState || (readiness.ok ? 'UNKNOWN' : 'UNREACHABLE');
        const ready = readiness.data?.ready === true;
        const criticalFailures = Array.isArray(readiness.data?.criticalFailures)
            ? readiness.data.criticalFailures
            : undefined;
        if (state !== lastState || ready !== lastReady) {
            sawTransition = true;
            core_1.logger.info('Restart progress', {
                state,
                ready,
                phase: summarizeRestartState(state, ready),
                ...(criticalFailures && criticalFailures.length > 0 ? { criticalFailures } : {}),
            });
            lastState = state;
            lastReady = ready;
        }
        if (state === 'RUNNING' && ready) {
            core_1.logger.info('Agent services restarted', {
                state,
                ready,
                elapsedMs: Date.now() - startedAt,
            });
            return;
        }
        if (state === 'ERROR') {
            throw new core_1.CLIError('Agent entered ERROR state during restart', 1, {
                criticalFailures,
                elapsedMs: Date.now() - startedAt,
            });
        }
        await (0, core_1.sleep)(RESTART_POLL_INTERVAL_MS);
    }
    throw new core_1.CLIError('Timed out waiting for agent restart to complete', 1, {
        lastState,
        lastReady,
        sawTransition,
        timeoutMs: RESTART_WAIT_TIMEOUT_MS,
        hint: 'Check agent logs or run iotctl status for current lifecycle state',
    });
}
function formatMaybeAge(hours) {
    if (hours === undefined || hours === null) {
        return 'n/a';
    }
    return `${hours}h`;
}
function formatMaybeTime(value) {
    if (!value) {
        return 'never';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString();
}
function describeCloudFetchError(error) {
    if (error.message?.includes('timeout'))
        return 'Connection timeout (5s)';
    const cause = error.cause;
    if (cause) {
        const code = cause.code;
        if (code === 'ECONNREFUSED')
            return 'Connection refused - is the cloud API running?';
        if (code === 'ECONNRESET')
            return 'Connection reset by remote host';
        if (code === 'ENOTFOUND')
            return 'DNS lookup failed for host';
        if (code === 'CERT_HAS_EXPIRED')
            return 'TLS certificate has expired';
        if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
            return 'TLS: self-signed certificate not trusted';
        if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
            return 'TLS: unable to verify certificate';
        if (cause.message)
            return cause.message;
    }
    return error.message || 'Unknown fetch error';
}
async function showStatusEnhanced() {
    (0, core_1.clearApiCache)();
    core_1.logger.info('Checking device health...');
    try {
        const [healthyProbe, readinessProbe, healthReportProbe] = await Promise.all([
            (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/healthy`),
            (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/readiness`),
            (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/health/report`),
        ]);
        const healthyPayload = healthyProbe.data || {};
        const readinessPayload = readinessProbe.data || {};
        const healthReportPayload = healthReportProbe.data || {};
        const report = healthReportPayload.report || {};
        const criticalFailures = Array.isArray(report.criticalFailures) ? report.criticalFailures : [];
        const unhealthySubsystems = Array.isArray(report.unhealthySubsystems) ? report.unhealthySubsystems : [];
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        core_1.logger.info('Agent running', {
            uuid: (0, core_1.redact)(deviceState.uuid),
            online: deviceState.is_online,
        });
        core_1.logger.info('Lifecycle', {
            state: healthyPayload.state || readinessPayload.state || healthyPayload.lifecycleState || readinessPayload.lifecycleState || 'UNKNOWN',
            ready: readinessPayload.ready === true,
            health: healthyPayload.status || 'unknown',
            criticalFailures,
            unhealthySubsystems,
        });
        core_1.logger.info('Environment', {
            isContainer: core_1.ENV.isContainer,
            hasDocker: core_1.ENV.hasDocker,
        });
        const apps = deviceState.apps || {};
        const appCount = Object.keys(apps).length;
        let runningCount = 0;
        for (const appId in apps) {
            const app = apps[appId];
            if (app.services) {
                runningCount += app.services.filter((s) => s.status === 'Running').length;
            }
        }
        core_1.logger.info('Applications', {
            configured: appCount,
            runningServices: runningCount,
        });
        try {
            const provisionStatus = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/provision/status`);
            if (provisionStatus.apiEndpoint) {
                core_1.logger.info('Cloud connection', {
                    endpoint: provisionStatus.apiEndpoint,
                    status: deviceState.is_online ? 'Connected' : 'Disconnected',
                });
            }
        }
        catch {
            // Ignore if unavailable
        }
        const dbSize = (0, core_1.getDbSizeMb)();
        if (dbSize !== null) {
            core_1.logger.info('Database', {
                size_mb: dbSize,
            });
        }
    }
    catch (error) {
        core_1.logger.error('Agent not running or unreachable', error, {
            hint: `Verify DEVICE_API_PORT/DEVICE_API_URL and confirm device API is listening (current target: ${core_1.DEVICE_API_BASE})`,
        });
    }
}
async function bufferStatus() {
    (0, core_1.clearApiCache)();
    core_1.logger.info('Checking offline buffer status...');
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/buffer/status`);
        core_1.logger.info('Buffer mode', { mode: result.mode });
        core_1.logger.info('Cloud report buffer', {
            cloudReportQueueCount: result.cloudReportQueueCount,
            cloudReportOldestAge: formatMaybeAge(result.cloudReportOldestAge),
            lastFlushAttempt: formatMaybeTime(result.lastFlushAttempt),
            lastFlushSuccess: formatMaybeTime(result.lastFlushSuccess),
        });
        core_1.logger.info('MQTT message buffer', {
            mqttMessageBufferCount: result.mqttMessageBufferCount,
            mqttBufferBytes: result.mqttBufferBytes,
            mqttBufferOldestAge: formatMaybeAge(result.mqttBufferOldestAge),
        });
        if (result.agentLogBufferEnabled) {
            core_1.logger.info('Agent log buffer', {
                agentLogBufferLogs: result.agentLogBufferLogs,
                agentLogBufferBytes: result.agentLogBufferBytes,
                agentLogPendingBatches: result.agentLogPendingBatches,
                agentLogDroppedTotal: result.agentLogDroppedTotal,
                agentLogCircuitOpen: result.agentLogCircuitOpen,
                agentLogLastFlushAttempt: formatMaybeTime(result.agentLogLastFlushAttempt),
                agentLogLastFlushSuccess: formatMaybeTime(result.agentLogLastFlushSuccess),
                agentLogLastFlushError: result.agentLogLastFlushError || 'none',
            });
        }
        else {
            core_1.logger.info('Agent log buffer', {
                status: 'not-enabled',
            });
        }
    }
    catch (error) {
        core_1.logger.error('Failed to read buffer status', error);
    }
}
async function memoryDiagnostics() {
    (0, core_1.clearApiCache)();
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/memory`);
        const d = result.diagnostics;
        const r = result.restartPolicy;
        const isLeaking = !!d.leakPattern;
        const statusLabel = isLeaking ? 'LEAK DETECTED' : (d.heapStable ? 'HEALTHY' : 'MONITORING');
        core_1.logger.info(`Memory status: ${statusLabel}`, {
            leakPattern: d.leakPattern || 'none',
            leakDescription: d.leakDescription || 'none',
            uptimeSeconds: d.uptimeSeconds,
            samples: d.samples,
        });
        core_1.logger.info('Heap (V8)', {
            currentMB: d.currentHeapMB,
            baselineMB: d.baselineHeapMB,
            growthFromBaselineMB: d.growthFromBaselineMB,
            growthRateMBperMin: d.heapGrowthRateMBperMin ?? 'n/a (< 10 samples)',
            utilization: d.heapUtilization,
            limitPressure: d.heapLimitPressure,
            thresholdMBperMin: d.heapThresholdMBperMin,
        });
        core_1.logger.info('RSS (resident set)', {
            currentMB: d.currentRSSMB,
            baselineMB: d.baselineRSSMB,
            growthFromBaselineMB: d.rssGrowthFromBaselineMB,
        });
        core_1.logger.info('External memory (Buffers / native)', {
            currentMB: d.currentExternalMB,
            baselineMB: d.baselineExternalMB,
            growthFromBaselineMB: d.externalGrowthFromBaselineMB,
            growthRateMBperMin: d.externalGrowthRateMBperMin ?? 'n/a',
            thresholdMBperMin: d.externalThresholdMBperMin,
        });
        core_1.logger.info('Survivor (long-lived objects)', {
            baselineMB: d.survivorBaselineMB,
            growthRateMBperMin: d.survivorGrowthRateMBperMin,
            floorMonotonic: d.survivorFloorMonotonic,
            retainedMB: d.survivorRetainedMB,
            thresholdMBperMin: d.survivorThresholdMBperMin,
        });
        core_1.logger.info('Restart policy', {
            canRestart: r.canRestart,
            blockReason: r.blockReason || 'none',
            attemptsSinceStartup: r.restartAttemptsSinceStartup,
            maxAttempts: r.maxAttempts,
            lastRestartAgo: r.timeSinceLastRestartMs != null
                ? `${Math.round(r.timeSinceLastRestartMs / 60000)} minutes ago`
                : 'never',
        });
    }
    catch (error) {
        core_1.logger.error('Failed to read memory diagnostics', error);
    }
}
async function restart() {
    try {
        const readiness = await (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/readiness`);
        const readinessState = readiness.data?.state || readiness.data?.lifecycleState || 'UNKNOWN';
        const readinessFlag = readiness.data?.ready === true;
        core_1.logger.info('Restarting agent services...', {
            state: readinessState,
            ready: readinessFlag,
        });
        const response = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/reboot`, {
            method: 'POST',
        });
        core_1.logger.info('Agent services restarting', {
            note: 'All services will reinitialize (API and MQTT stay running)',
            state: response.state || response.lifecycleState || readinessState,
        });
        await waitForRestartCompletion(response.state || response.lifecycleState || readinessState);
    }
    catch (error) {
        throw new core_1.CLIError('Failed to restart agent services', 1, {
            error: error.message,
        });
    }
}
async function runDiagnostics() {
    core_1.logger.info('Running system diagnostics...');
    const results = {};
    const checkDeviceApi = async () => {
        try {
            const response = await fetch(`${core_1.DEVICE_API_V1}/device`);
            if (response.ok) {
                const json = await response.json();
                const data = json.Data ?? json;
                results['Device API'] = {
                    status: '✓ OK',
                    message: `Connected to ${core_1.DEVICE_API_BASE}`,
                    details: { uuid: (0, core_1.redact)(data.uuid), provisioned: data.provisioned },
                };
            }
            else {
                results['Device API'] = {
                    status: '✗ FAIL',
                    message: `HTTP ${response.status}`,
                    details: { endpoint: core_1.DEVICE_API_BASE },
                };
            }
        }
        catch (error) {
            results['Device API'] = {
                status: '✗ FAIL',
                message: error.message,
                details: { endpoint: core_1.DEVICE_API_BASE },
            };
        }
    };
    const checkDatabase = async () => {
        try {
            if ((0, fs_1.existsSync)(core_1.DB_PATH)) {
                const dbSize = (0, core_1.getDbSizeMb)();
                results['Database'] = {
                    status: '✓ OK',
                    message: 'SQLite database exists',
                    details: { path: core_1.DB_PATH, size: dbSize ? `${dbSize} MB` : 'unknown' },
                };
            }
            else {
                results['Database'] = {
                    status: '✗ FAIL',
                    message: 'Database file not found',
                    details: { path: core_1.DB_PATH },
                };
            }
        }
        catch (error) {
            results['Database'] = {
                status: '✗ FAIL',
                message: error.message,
                details: { path: core_1.DB_PATH },
            };
        }
    };
    const checkProvisioning = async () => {
        try {
            const response = await fetch(`${core_1.DEVICE_API_V1}/provision/status`);
            if (response.ok) {
                const json = await response.json();
                const data = json.Data ?? json;
                const provisioned = data.provisioned;
                results['Provisioning'] = {
                    status: provisioned ? '✓ OK' : '⚠ WARN',
                    message: provisioned ? 'Device is provisioned' : 'Device not provisioned',
                    details: {
                        apiEndpoint: data.apiEndpoint,
                        deviceId: (0, core_1.redact)(data.deviceId),
                        mqttBroker: data.mqttBrokerUrl || 'not set',
                    },
                };
            }
            else {
                results['Provisioning'] = {
                    status: '✗ FAIL',
                    message: `Cannot check status (HTTP ${response.status})`,
                };
            }
        }
        catch (error) {
            results['Provisioning'] = {
                status: '✗ FAIL',
                message: error.message,
            };
        }
    };
    const checkInternet = async () => {
        try {
            const testUrls = ['https://www.google.com', 'https://1.1.1.1', 'https://8.8.8.8'];
            let connected = false;
            let successUrl = '';
            for (const url of testUrls) {
                try {
                    const response = await fetch(url, {
                        method: 'HEAD',
                        signal: AbortSignal.timeout(3000),
                    });
                    if (response.ok || response.status < 500) {
                        connected = true;
                        successUrl = url;
                        break;
                    }
                }
                catch {
                    continue;
                }
            }
            if (connected) {
                results['Internet'] = {
                    status: '✓ OK',
                    message: 'Internet connection available',
                    details: { testedUrl: successUrl },
                };
            }
            else {
                results['Internet'] = {
                    status: '✗ FAIL',
                    message: 'No internet connectivity detected',
                    details: { note: 'Tested Google, Cloudflare, and Google DNS' },
                };
            }
        }
        catch (error) {
            results['Internet'] = {
                status: '✗ FAIL',
                message: 'Internet check failed',
                details: { error: error.message },
            };
        }
    };
    const checkEnvironment = async () => {
        const envVars = {
            DEVICE_API_PORT: process.env.DEVICE_API_PORT || '(default: 48484)',
            IOTISTICA_API: process.env.IOTISTICA_API || '(not set)',
            PROVISIONING_API_KEY: process.env.PROVISIONING_API_KEY ? '(set)' : '(not set)',
            CONFIG_DIR: process.env.CONFIG_DIR || '/app/data',
        };
        results['Environment'] = {
            status: '⊘ INFO',
            message: 'Configuration variables',
            details: envVars,
        };
    };
    const checkLifecycle = async () => {
        try {
            const [healthyProbe, readinessProbe, healthReportProbe] = await Promise.all([
                (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/healthy`),
                (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/readiness`),
                (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/health/report`),
            ]);
            const healthy = healthyProbe.data || {};
            const readiness = readinessProbe.data || {};
            const healthReport = healthReportProbe.data || {};
            const report = healthReport.report || {};
            const criticalFailures = Array.isArray(report.criticalFailures) ? report.criticalFailures : [];
            const unhealthySubsystems = Array.isArray(report.unhealthySubsystems) ? report.unhealthySubsystems : [];
            const state = readiness.state || healthy.state || readiness.lifecycleState || healthy.lifecycleState || 'UNKNOWN';
            const ready = readiness.ready === true;
            const healthStatus = healthy.status || (healthyProbe.ok ? 'healthy' : 'unhealthy');
            const hasCriticalFailures = criticalFailures.length > 0;
            results['Lifecycle'] = {
                status: hasCriticalFailures ? '✗ FAIL' : (ready ? '✓ OK' : '⚠ WARN'),
                message: `State=${state}, Ready=${ready}, Health=${healthStatus}`,
                details: {
                    state,
                    ready,
                    health: healthStatus,
                    healthHttpStatus: healthyProbe.status,
                    readinessHttpStatus: readinessProbe.status,
                    healthReportHttpStatus: healthReportProbe.status,
                    criticalFailures,
                    unhealthySubsystems,
                },
            };
        }
        catch (error) {
            results['Lifecycle'] = {
                status: '✗ FAIL',
                message: error.message,
                details: {
                    hint: 'Unable to query /v1/healthy or /v1/readiness',
                },
            };
        }
    };
    await Promise.allSettled([
        checkDeviceApi(),
        checkLifecycle(),
        checkDatabase(),
        checkProvisioning(),
        checkInternet(),
        checkEnvironment(),
    ]);
    if (results['Provisioning']?.details?.apiEndpoint) {
        const cloudEndpoint = results['Provisioning'].details.apiEndpoint;
        try {
            const isLocalhost = /^https:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(cloudEndpoint);
            const fetchFn = isLocalhost
                ? (url, init) => (0, undici_1.fetch)(url, {
                    ...init,
                    dispatcher: new undici_1.Agent({ connect: { rejectUnauthorized: false } }),
                })
                : fetch;
            const response = await fetchFn(`${cloudEndpoint}/health`, {
                signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
                results['Cloud API'] = {
                    status: '✓ OK',
                    message: 'Cloud API reachable',
                    details: { endpoint: cloudEndpoint },
                };
            }
            else {
                results['Cloud API'] = {
                    status: '✗ FAIL',
                    message: `HTTP ${response.status}`,
                    details: { endpoint: cloudEndpoint },
                };
            }
        }
        catch (error) {
            results['Cloud API'] = {
                status: '✗ FAIL',
                message: describeCloudFetchError(error),
                details: { endpoint: cloudEndpoint },
            };
        }
    }
    else {
        results['Cloud API'] = {
            status: '⊘ SKIP',
            message: 'Not provisioned - skipping cloud check',
        };
    }
    if (results['Provisioning']?.details?.mqttBroker) {
        const mqttBroker = results['Provisioning'].details.mqttBroker;
        results['MQTT Broker'] = {
            status: '⊘ INFO',
            message: 'Configured broker',
            details: { url: mqttBroker, note: 'Cannot test connection from CLI' },
        };
    }
    else {
        results['MQTT Broker'] = {
            status: '⊘ SKIP',
            message: 'Not provisioned - no MQTT broker configured',
        };
    }
    console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║                    SYSTEM DIAGNOSTICS                             ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
    for (const [component, result] of Object.entries(results)) {
        console.log(`${result.status.padEnd(10)} ${component}`);
        console.log(`           ${result.message}`);
        if (result.details) {
            console.log(`           ${JSON.stringify(result.details, null, 2).split('\n').join('\n           ')}`);
        }
        console.log();
    }
    const failures = Object.values(results).filter((r) => r.status.includes('✗')).length;
    const warnings = Object.values(results).filter((r) => r.status.includes('⚠')).length;
    if (failures > 0) {
        throw new core_1.CLIError(`Diagnostics completed with ${failures} failure(s) and ${warnings} warning(s)`, 1);
    }
    if (warnings > 0) {
        console.log(`\n⚠️  Diagnostics completed with ${warnings} warning(s)`);
    }
    else {
        console.log('\n✅ All diagnostics passed!');
    }
}
async function agentUpdate(version) {
    const args = process.argv.slice(2);
    const targetVersion = version || args.find((a) => !a.startsWith('-')) || 'latest';
    const force = args.includes('--force') || args.includes('-f');
    core_1.logger.info('Triggering agent update', { version: targetVersion, force });
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/update`, {
            method: 'POST',
            body: JSON.stringify({ version: targetVersion, force }),
        });
        core_1.logger.info('Update triggered', {
            status: result.status,
            version: result.version,
            note: 'The agent will restart when the update script completes.',
        });
    }
    catch (error) {
        const status = error?.status || error?.statusCode;
        if (status === 503) {
            throw new core_1.CLIError('Agent updater is not available on this device', 1, {
                hint: 'Ensure the agent is running as a systemd service and UPDATE_COMMAND_SECRET is configured.',
            });
        }
        throw error;
    }
}
//# sourceMappingURL=device.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIngestionServer = createIngestionServer;
const http_1 = require("http");
const crypto_1 = require("crypto");
const logger_1 = __importDefault(require("../utils/logger"));
const services_1 = require("../services");
const readings_service_1 = require("../services/readings.service");
const prometheus_1 = require("../services/prometheus");
function getRequestId(req) {
    const rawHeader = req.headers['x-request-id'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    return headerValue?.trim() || (0, crypto_1.randomUUID)();
}
function assertInternalAuth(requestToken) {
    const expectedToken = process.env.INTERNAL_AUTH_TOKEN?.trim();
    if (!expectedToken) {
        throw new Error('INTERNAL_AUTH_TOKEN must be set for the ingestion service');
    }
    if (!requestToken || requestToken !== expectedToken) {
        const error = new Error('Unauthorized internal request');
        error.statusCode = 401;
        throw error;
    }
}
function sendJson(reply, statusCode, body, requestId) {
    const payload = JSON.stringify(body);
    reply.statusCode = statusCode;
    reply.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (requestId) {
        reply.setHeader('x-request-id', requestId);
    }
    reply.end(payload);
}
function sendText(reply, statusCode, body, requestId) {
    reply.statusCode = statusCode;
    reply.setHeader('Content-Type', 'text/plain; version=0.0.4');
    if (requestId) {
        reply.setHeader('x-request-id', requestId);
    }
    reply.end(body);
}
function getInternalAuthHeader(req) {
    const rawHeader = req.headers['x-internal-auth-token'];
    return Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunks.push(bufferChunk);
        const totalBytes = chunks.reduce((sum, item) => sum + item.length, 0);
        if (totalBytes > 1024 * 1024) {
            const error = new Error('Request body too large');
            error.statusCode = 413;
            throw error;
        }
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8').trim();
    if (!rawBody) {
        const error = new Error('Request body is required');
        error.statusCode = 400;
        throw error;
    }
    try {
        return JSON.parse(rawBody);
    }
    catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        throw error;
    }
}
async function routeRequest(req, reply, requestId) {
    const method = req.method || 'GET';
    const url = req.url || '/';
    if (method === 'POST' && url === '/api/v1/readings/internal') {
        try {
            assertInternalAuth(getInternalAuthHeader(req));
            const reading = await readJsonBody(req);
            await readings_service_1.readingsService.insert({
                agent_uuid: reading.agent_uuid,
                metric_name: reading.metric_name,
                value: reading.value,
                unit: reading.unit,
                protocol: reading.protocol,
                quality: reading.quality,
                extra: reading.extra || {},
            });
            sendJson(reply, 201, { message: 'Reading inserted successfully' }, requestId);
        }
        catch (error) {
            logger_1.default.error('Error inserting reading in ingestion service', {
                error: error instanceof Error ? error.message : String(error),
            });
            const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) || 500 : 500;
            sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : error instanceof Error ? error.message : 'Internal server error' }, requestId);
        }
        return;
    }
    if (method !== 'GET') {
        sendJson(reply, 405, { error: 'Method not allowed' }, requestId);
        return;
    }
    if (url === '/health') {
        sendJson(reply, 200, {
            status: 'healthy',
            service: 'iotistica-ingestion',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        }, requestId);
        return;
    }
    if (url === '/metrics') {
        sendText(reply, 200, (0, prometheus_1.renderIngestionPrometheusMetrics)(), requestId);
        return;
    }
    if (url === '/api/v1/metrics/ingestion-health') {
        try {
            assertInternalAuth(getInternalAuthHeader(req));
            sendJson(reply, 200, await services_1.redisDeviceQueue.getIngestionHealth(), requestId);
        }
        catch (error) {
            logger_1.default.error('Error getting ingestion health from ingestion service', {
                error: error instanceof Error ? error.message : String(error),
            });
            const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) || 500 : 500;
            sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : 'Internal server error' }, requestId);
        }
        return;
    }
    if (url === '/api/v1/admin/ingestion/stats') {
        try {
            assertInternalAuth(getInternalAuthHeader(req));
            sendJson(reply, 200, await services_1.redisDeviceQueue.getStats(), requestId);
        }
        catch (error) {
            logger_1.default.error('Error getting ingestion stats from ingestion service', {
                error: error instanceof Error ? error.message : String(error),
            });
            const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) || 500 : 500;
            sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : 'Internal server error' }, requestId);
        }
        return;
    }
    sendJson(reply, 404, {
        error: 'Not found',
    }, requestId);
}
function createIngestionServer() {
    return (0, http_1.createServer)((req, reply) => {
        const requestId = getRequestId(req);
        const start = process.hrtime.bigint();
        logger_1.default.info('incoming request', {
            reqId: requestId,
            req: {
                method: req.method,
                url: req.url,
                host: req.headers.host,
                remoteAddress: req.socket.remoteAddress,
                remotePort: req.socket.remotePort,
            },
        });
        reply.on('finish', () => {
            const durationNs = process.hrtime.bigint() - start;
            const responseTime = Number(durationNs) / 1_000_000;
            logger_1.default.info('request completed', {
                reqId: requestId,
                res: { statusCode: reply.statusCode },
                responseTime,
            });
        });
        routeRequest(req, reply, requestId).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error ? error.stack : undefined;
            logger_1.default.error('Ingestion server error', {
                error: message,
                stack,
            });
            if (!reply.headersSent) {
                sendJson(reply, 500, { error: message }, requestId);
                return;
            }
            reply.destroy();
        });
    });
}
//# sourceMappingURL=app.js.map
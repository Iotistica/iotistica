"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const bull_1 = __importDefault(require("bull"));
const ioredis_1 = __importDefault(require("ioredis"));
const api_1 = require("@bull-board/api");
const bullAdapter_1 = require("@bull-board/api/bullAdapter");
const express_2 = require("@bull-board/express");
const index_1 = require("./index");
const logger_1 = __importDefault(require("./utils/logger"));
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3300');
const HOST = process.env.HOST || '0.0.0.0';
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const emailConfig = {
    enabled: process.env.EMAIL_ENABLED !== 'false',
    from: process.env.EMAIL_FROM || '"Iotistica Platform" <noreply@iotistica.com>',
    debug: process.env.EMAIL_DEBUG === 'true',
};
if (process.env.SMTP_HOST) {
    emailConfig.smtp = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || '',
        },
    };
}
else if (process.env.AWS_SES_REGION) {
    emailConfig.ses = {
        region: process.env.AWS_SES_REGION,
        sourceArn: process.env.AWS_SES_SOURCE_ARN,
        fromArn: process.env.AWS_SES_FROM_ARN,
    };
}
const baseUrl = process.env.BASE_URL || 'https://iotistica.com';
const postOffice = new index_1.PostOffice(emailConfig, logger_1.default, baseUrl);
const redisConfig = {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
};
const emailQueue = new bull_1.default('email', {
    redis: redisConfig,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: false,
        removeOnFail: false,
    },
});
emailQueue.process(async (job) => {
    const { user, templateName, context } = job.data;
    logger_1.default.info(`Processing email job`, {
        jobId: job.id,
        template: templateName,
        to: user.email,
    });
    try {
        await postOffice.send(user, templateName, context);
        logger_1.default.info(`Email sent successfully`, {
            jobId: job.id,
            template: templateName,
            to: user.email,
        });
    }
    catch (error) {
        logger_1.default.error(`Failed to send email`, {
            jobId: job.id,
            template: templateName,
            to: user.email,
            error: error.message,
        });
        throw error;
    }
});
emailQueue.on('completed', (job) => {
    logger_1.default.debug(`Email job completed`, { jobId: job.id });
});
emailQueue.on('failed', (job, err) => {
    logger_1.default.warn(`Email job failed`, {
        jobId: job?.id,
        error: err.message,
        attempts: job?.attemptsMade,
    });
});
const serverAdapter = new express_2.ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
(0, api_1.createBullBoard)({
    queues: [new bullAdapter_1.BullAdapter(emailQueue)],
    serverAdapter: serverAdapter,
});
app.use('/admin/queues', serverAdapter.getRouter());
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'postoffice',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        email: {
            enabled: postOffice.isEnabled(),
            settings: postOffice.getSettings(),
        },
    });
});
app.get('/ready', async (req, res) => {
    try {
        const redisClient = new ioredis_1.default(redisConfig);
        await redisClient.ping();
        redisClient.disconnect();
        res.json({
            status: 'ready',
            email: postOffice.isEnabled(),
            queue: 'connected',
        });
    }
    catch (error) {
        logger_1.default.error('Readiness check failed', { error: error.message });
        res.status(503).json({
            status: 'not ready',
            error: error.message,
        });
    }
});
app.post('/api/email/send', async (req, res) => {
    try {
        const { user, templateName, context } = req.body;
        if (!user || !user.email) {
            return res.status(400).json({ error: 'User with email is required' });
        }
        if (!templateName) {
            return res.status(400).json({ error: 'Template name is required' });
        }
        const job = await emailQueue.add({
            user,
            templateName,
            context: context || {},
        });
        res.json({
            message: 'Email queued successfully',
            jobId: job.id,
        });
    }
    catch (error) {
        logger_1.default.error('Failed to queue email', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/email/stats', async (req, res) => {
    try {
        const [waiting, active, completed, failed] = await Promise.all([
            emailQueue.getWaitingCount(),
            emailQueue.getActiveCount(),
            emailQueue.getCompletedCount(),
            emailQueue.getFailedCount(),
        ]);
        res.json({
            queue: {
                waiting,
                active,
                completed,
                failed,
                total: waiting + active + completed + failed,
            },
            email: {
                enabled: postOffice.isEnabled(),
                settings: postOffice.getSettings(true),
            },
        });
    }
    catch (error) {
        logger_1.default.error('Failed to get queue stats', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/email/failed', async (req, res) => {
    try {
        const failed = await emailQueue.getFailed();
        res.json({
            count: failed.length,
            jobs: failed.map((job) => ({
                id: job.id,
                data: job.data,
                failedReason: job.failedReason,
                attemptsMade: job.attemptsMade,
                timestamp: job.timestamp,
            })),
        });
    }
    catch (error) {
        logger_1.default.error('Failed to get failed jobs', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/email/retry/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await emailQueue.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        await job.retry();
        res.json({ message: 'Job queued for retry', jobId });
    }
    catch (error) {
        logger_1.default.error('Failed to retry job', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.get('/', (req, res) => {
    res.json({
        service: 'iotistic-postoffice',
        version: '1.0.0',
        description: 'Standalone email service with queue processing',
        endpoints: {
            health: '/health',
            ready: '/ready',
            send: 'POST /api/email/send',
            stats: '/api/email/stats',
            failed: '/api/email/failed',
            retry: 'POST /api/email/retry/:jobId',
            queueUI: '/admin/queues',
        },
    });
});
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});
app.use((err, req, res, next) => {
    logger_1.default.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
    });
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
});
async function gracefulShutdown(signal) {
    logger_1.default.info(`${signal} signal received, starting graceful shutdown...`);
    server.close(() => {
        logger_1.default.info('HTTP server closed');
    });
    try {
        await emailQueue.close();
        logger_1.default.info('Email queue closed');
        await postOffice.close();
        logger_1.default.info('PostOffice closed');
        logger_1.default.info('Graceful shutdown completed');
        process.exit(0);
    }
    catch (error) {
        logger_1.default.error('Error during graceful shutdown', { error: error.message });
        process.exit(1);
    }
}
let server;
async function startServer() {
    try {
        logger_1.default.info('Starting PostOffice service...');
        const redisClient = new ioredis_1.default(redisConfig);
        await redisClient.ping();
        redisClient.disconnect();
        logger_1.default.info('Redis connection successful');
        server = app.listen(PORT, HOST, () => {
            logger_1.default.info(`PostOffice service started`, {
                port: PORT,
                host: HOST,
                environment: process.env.NODE_ENV || 'production',
                emailEnabled: postOffice.isEnabled(),
            });
        });
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
    catch (error) {
        logger_1.default.error('Failed to start server', {
            error: error.message,
            stack: error.stack,
        });
        process.exit(1);
    }
}
startServer();
//# sourceMappingURL=server.js.map
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostOffice = void 0;
const handlebars_1 = __importDefault(require("handlebars"));
const nodemailer_1 = __importDefault(require("nodemailer"));
const sanitizer_1 = require("./sanitizer");
const layout_1 = require("./layout");
const templates = __importStar(require("./templates"));
class PostOffice {
    config;
    logger;
    baseUrl;
    mailTransport;
    templates = new Map();
    enabled = false;
    mailDefaults;
    exportableSettings = {};
    constructor(config, logger, baseUrl = 'http://localhost') {
        this.config = config;
        this.logger = logger;
        this.baseUrl = baseUrl;
        this.mailDefaults = {
            from: config.from || '"Iotistica Platform" <donotreply@iotistic.ca>'
        };
        this.registerTemplate('VerifyEmail', templates.VerifyEmail);
        this.registerTemplate('UserSuspended', templates.UserSuspended);
        this.registerTemplate('InviteUser', templates.InviteUser);
        if (this.isConfigured()) {
            this.init();
        }
    }
    isConfigured() {
        return this.config.enabled && (!!this.config.smtp ||
            !!this.config.transport ||
            !!this.config.ses);
    }
    async init() {
        try {
            if (this.config.smtp) {
                await this.initSMTP();
            }
            else if (this.config.transport) {
                await this.initTransport();
            }
            else if (this.config.ses) {
                await this.initSES();
            }
        }
        catch (error) {
            this.logger.error(`Failed to initialize email: ${error}`);
            this.enabled = false;
        }
    }
    async initSMTP() {
        const smtpConfig = this.config.smtp;
        this.mailTransport = nodemailer_1.default.createTransport(smtpConfig, this.mailDefaults);
        this.exportableSettings = {
            host: smtpConfig.host,
            port: smtpConfig.port
        };
        try {
            await this.mailTransport.verify();
            this.logger.info('Connected to SMTP server');
            this.enabled = true;
        }
        catch (error) {
            this.logger.error(`Failed to verify SMTP connection: ${error}`);
            this.enabled = false;
        }
    }
    async initTransport() {
        this.mailTransport = nodemailer_1.default.createTransport(this.config.transport, this.mailDefaults);
        this.exportableSettings = {};
        this.logger.info('Email using config provided transport');
        this.enabled = true;
    }
    async initSES() {
        try {
            const { SES } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-ses')));
            const { defaultProvider } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/credential-provider-node')));
            const sesConfig = this.config.ses;
            const ses = new SES({
                apiVersion: '2010-12-01',
                region: sesConfig.region,
                credentialDefaultProvider: defaultProvider
            });
            const mailDefaults = { ...this.mailDefaults };
            if (sesConfig.sourceArn) {
                mailDefaults.ses = {
                    SourceArn: sesConfig.sourceArn,
                    FromArn: sesConfig.fromArn || sesConfig.sourceArn
                };
            }
            this.mailTransport = nodemailer_1.default.createTransport({
                SES: { ses, aws: { SES } }
            }, mailDefaults);
            this.exportableSettings = {
                region: sesConfig.region
            };
            await this.mailTransport.verify();
            this.logger.info('Connected to AWS SES');
            this.enabled = true;
        }
        catch (error) {
            this.logger.error(`Failed to verify SES connection: ${error}`);
            this.enabled = false;
        }
    }
    registerTemplate(templateName, template) {
        this.templates.set(templateName, {
            subject: handlebars_1.default.compile(template.subject, { noEscape: true }),
            text: handlebars_1.default.compile(template.text, { noEscape: true }),
            html: handlebars_1.default.compile(template.html)
        });
    }
    getTemplate(templateName) {
        return this.templates.get(templateName);
    }
    async send(user, templateName, context = {}) {
        const template = this.getTemplate(templateName);
        if (!template) {
            throw new Error(`Template '${templateName}' not found`);
        }
        const templateContext = {
            baseUrl: this.baseUrl,
            user,
            ...context
        };
        templateContext.safeName = (0, sanitizer_1.sanitizeText)(user.name || 'user');
        if (templateContext.teamName) {
            templateContext.teamName = (0, sanitizer_1.sanitizeText)(templateContext.teamName);
        }
        if (templateContext.invitee) {
            templateContext.invitee = (0, sanitizer_1.sanitizeText)(templateContext.invitee);
        }
        if (Array.isArray(templateContext.log) && templateContext.log.length > 0) {
            templateContext.log = (0, sanitizer_1.sanitizeLog)(templateContext.log);
        }
        else {
            delete templateContext.log;
        }
        const handlebarsOptions = {
            allowProtoPropertiesByDefault: true,
            allowProtoMethodsByDefault: true
        };
        const mail = {
            to: user.email,
            subject: template.subject(templateContext),
            text: template.text(templateContext),
            html: (0, layout_1.defaultLayout)(template.html(templateContext))
        };
        if (this.config.debug) {
            this.logger.info(`
-----------------------------------
to: ${mail.to}
subject: ${mail.subject}
------
${mail.text}
-----------------------------------`);
        }
        if (this.enabled && this.mailTransport) {
            try {
                await this.mailTransport.sendMail(mail);
            }
            catch (error) {
                this.logger.warn(`Failed to send email: ${error}`);
            }
        }
    }
    isEnabled() {
        return this.enabled;
    }
    getSettings(isAdmin = false) {
        if (!this.enabled) {
            return false;
        }
        return isAdmin ? this.exportableSettings : true;
    }
    async close() {
        if (this.mailTransport) {
            this.mailTransport.close();
        }
    }
}
exports.PostOffice = PostOffice;
//# sourceMappingURL=index.js.map
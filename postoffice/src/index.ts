import handlebars from 'handlebars';
import nodemailer from 'nodemailer';
import { 
  EmailConfig, 
  User, 
  EmailTemplate, 
  CompiledTemplate, 
  MailOptions, 
  Logger,
  LogEntry 
} from './types';
import { sanitizeText, sanitizeLog } from './sanitizer';
import { defaultLayout } from './layout';
import * as templates from './templates';

export class PostOffice {
  private mailTransport?: nodemailer.Transporter;
  private templates: Map<string, CompiledTemplate> = new Map();
  private enabled = false;
  private readonly mailDefaults: { from: string };
  private exportableSettings: Record<string, any> = {};

  constructor(
    private config: EmailConfig,
    private logger: Logger,
    private baseUrl = 'http://localhost'
  ) {
    this.mailDefaults = { 
      from: config.from || '"Iotistica Platform" <donotreply@iotistic.ca>' 
    };
    
    // Register built-in templates
    this.registerTemplate('VerifyEmail', templates.VerifyEmail);
    this.registerTemplate('UserSuspended', templates.UserSuspended);
    this.registerTemplate('InviteUser', templates.InviteUser);
    
    // Initialize if configured
    if (this.isConfigured()) {
      this.init();
    }
  }

  private isConfigured(): boolean {
    return this.config.enabled && (
      !!this.config.smtp || 
      !!this.config.transport || 
      !!this.config.ses
    );
  }

  private async init(): Promise<void> {
    try {
      if (this.config.smtp) {
        await this.initSMTP();
      } else if (this.config.transport) {
        await this.initTransport();
      } else if (this.config.ses) {
        await this.initSES();
      }
    } catch (error) {
      this.logger.error(`Failed to initialize email: ${error}`);
      this.enabled = false;
    }
  }

  private async initSMTP(): Promise<void> {
    const smtpConfig = this.config.smtp!;
    this.mailTransport = nodemailer.createTransport(smtpConfig, this.mailDefaults);
    this.exportableSettings = {
      host: smtpConfig.host,
      port: smtpConfig.port
    };

    try {
      await this.mailTransport.verify();
      this.logger.info('Connected to SMTP server');
      this.enabled = true;
    } catch (error) {
      this.logger.error(`Failed to verify SMTP connection: ${error}`);
      this.enabled = false;
    }
  }

  private async initTransport(): Promise<void> {
    this.mailTransport = nodemailer.createTransport(this.config.transport!, this.mailDefaults);
    this.exportableSettings = {};
    this.logger.info('Email using config provided transport');
    this.enabled = true;
  }

  private async initSES(): Promise<void> {
    try {
      const { SES } = await import('@aws-sdk/client-ses');
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');

      const sesConfig = this.config.ses!;
      const ses = new SES({
        apiVersion: '2010-12-01',
        region: sesConfig.region,
        credentialDefaultProvider: defaultProvider
      });

      const mailDefaults = { ...this.mailDefaults } as any;
      if (sesConfig.sourceArn) {
        mailDefaults.ses = {
          SourceArn: sesConfig.sourceArn,
          FromArn: sesConfig.fromArn || sesConfig.sourceArn
        };
      }

      this.mailTransport = nodemailer.createTransport({
        SES: { ses, aws: { SES } }
      } as any, mailDefaults);

      this.exportableSettings = {
        region: sesConfig.region
      };

      await this.mailTransport.verify();
      this.logger.info('Connected to AWS SES');
      this.enabled = true;
    } catch (error) {
      this.logger.error(`Failed to verify SES connection: ${error}`);
      this.enabled = false;
    }
  }

  public registerTemplate(templateName: string, template: EmailTemplate): void {
    this.templates.set(templateName, {
      subject: handlebars.compile(template.subject, { noEscape: true }),
      text: handlebars.compile(template.text, { noEscape: true }),
      html: handlebars.compile(template.html)
    });
  }

  private getTemplate(templateName: string): CompiledTemplate | undefined {
    return this.templates.get(templateName);
  }

  public async send(user: User, templateName: string, context: any = {}): Promise<void> {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template '${templateName}' not found`);
    }

    const templateContext = { 
      baseUrl: this.baseUrl, 
      user, 
      ...context 
    };

    // Add sanitized name
    templateContext.safeName = sanitizeText(user.name || 'user');

    // Sanitize team name if present
    if (templateContext.teamName) {
      templateContext.teamName = sanitizeText(templateContext.teamName);
    }

    // Sanitize invitee if present
    if (templateContext.invitee) {
      templateContext.invitee = sanitizeText(templateContext.invitee);
    }

    // Sanitize log if present
    if (Array.isArray(templateContext.log) && templateContext.log.length > 0) {
      templateContext.log = sanitizeLog(templateContext.log as LogEntry[]);
    } else {
      delete templateContext.log;
    }

    const handlebarsOptions = { 
      allowProtoPropertiesByDefault: true, 
      allowProtoMethodsByDefault: true 
    };

    const mail: MailOptions = {
      to: user.email,
      subject: template.subject(templateContext),
      text: template.text(templateContext),
      html: defaultLayout(template.html(templateContext))
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
      } catch (error) {
        this.logger.warn(`Failed to send email: ${error}`);
      }
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getSettings(isAdmin = false): Record<string, any> | boolean {
    if (!this.enabled) {
      return false;
    }
    return isAdmin ? this.exportableSettings : true;
  }

  public async close(): Promise<void> {
    if (this.mailTransport) {
      this.mailTransport.close();
    }
  }
}
import { PostOffice } from './index';
import { EmailConfig, Logger } from './types';

// Example logger implementation
const logger: Logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`)
};

// Example email configuration
const emailConfig: EmailConfig = {
  enabled: true,
  from: '"Iotistic Platform" <noreply@iotistica.com>',
  debug: true,
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'your-email@gmail.com',
      pass: 'your-app-password'
    }
  }
};

// Initialize PostOffice
const postOffice = new PostOffice(emailConfig, logger, 'https://your-domain.com');

// Example usage
async function sendWelcomeEmail() {
  const user = {
    email: 'user@example.com',
    name: 'John Doe'
  };

  const context = {
    token: {
      token: '123456'
    }
  };

  try {
    await postOffice.send(user, 'VerifyEmail', context);
    console.log('Email sent successfully');
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

// Add custom template
postOffice.registerTemplate('CustomWelcome', {
  subject: 'Welcome to {{baseUrl}}',
  text: 'Hello {{safeName.text}}, welcome to our platform!',
  html: '<p>Hello <strong>{{safeName.html}}</strong>, welcome to our platform!</p>'
});

export { postOffice };
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postOffice = void 0;
const index_1 = require("./index");
const logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`)
};
const emailConfig = {
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
const postOffice = new index_1.PostOffice(emailConfig, logger, 'https://your-domain.com');
exports.postOffice = postOffice;
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
    }
    catch (error) {
        console.error('Failed to send email:', error);
    }
}
postOffice.registerTemplate('CustomWelcome', {
    subject: 'Welcome to {{baseUrl}}',
    text: 'Hello {{safeName.text}}, welcome to our platform!',
    html: '<p>Hello <strong>{{safeName.html}}</strong>, welcome to our platform!</p>'
});
//# sourceMappingURL=example.js.map
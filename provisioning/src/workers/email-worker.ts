/**
 * Email Worker
 * Processes email jobs from the Bull queue
 * 
 * Job Type: send-admin-password-reset-link
 * Purpose: Send password reset link to customer (SOC2 compliant)
 */

import { Job } from 'bull';
import { emailQueue, SendPasswordResetLinkJobData } from '../services/email-queue';
import { logger } from '../utils/logger';

/**
 * Process password reset link email job
 * 
 * This worker:
 * 1. Validates the reset link
 * 2. Sends email to customer with reset link
 * 3. Never includes plaintext password
 * 4. Handles retries automatically via Bull
 */
export async function processSendPasswordResetLinkJob(
  job: Job<SendPasswordResetLinkJobData>
) {
  const { customerId, email, clientId, resetLink, expiresAt } = job.data;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`📧 Processing Email Job: ${job.id}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Customer: ${customerId}`);
  console.log(`Email: ${email}`);
  console.log(`Client: ${clientId}`);
  console.log(`Reset Link: ${resetLink}`);
  console.log(`Expires: ${expiresAt}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    // Update job progress
    job.progress(0);

    // Validate inputs
    if (!email || !resetLink || !expiresAt) {
      throw new Error('Missing required email job data');
    }

    console.log(`✓ Job data validated`);
    job.progress(20);

    // Build email content
    const emailSubject = 'Set Your Admin Password - Iotistica';
    const emailBody = buildPasswordResetEmail({
      customerName: clientId,
      resetLink,
      expiresAt: new Date(expiresAt).toLocaleString(),
    });

    console.log(`✓ Email content built`);
    console.log(`  Subject: ${emailSubject}`);
    console.log(`  Body preview:\n${emailBody.substring(0, 200)}...`);
    job.progress(40);

    // TODO: Send email via email service (SendGrid, SES, etc.)
    // For now, just log it
    // const result = await sendEmailService.send({
    //   to: email,
    //   subject: emailSubject,
    //   html: emailBody,
    //   replyTo: 'support@iotistica.com',
    //   tags: ['admin-password-reset', clientId],
    // });

    console.log(`✓ Email would be sent to: ${email}`);
    console.log(`  [MOCK] Email sent successfully (implement actual email service)`);
    job.progress(80);

    // Log audit event
    logger.info('Password reset email job processed', {
      jobId: job.id,
      customerId,
      email,
      clientId,
      expiresAt,
      status: 'completed',
    });

    console.log(`✅ Email job completed: ${job.id}\n`);
    job.progress(100);

    return {
      success: true,
      jobId: job.id,
      email,
      sentAt: new Date().toISOString(),
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    console.error(`❌ Email job failed: ${job.id}`);
    console.error(`   Error: ${errorMessage}`);
    console.error(`   Retry attempt: ${job.attemptsMade + 1}/${job.opts.attempts}\n`);

    logger.error('Password reset email job failed', {
      jobId: job.id,
      customerId,
      email,
      clientId,
      attemptsMade: job.attemptsMade,
      attemptsTotal: job.opts.attempts,
      error: errorMessage,
    });

    // Bull will automatically retry based on backoff policy
    throw error;
  }
}

/**
 * Build password reset email HTML
 */
function buildPasswordResetEmail(options: {
  customerName: string;
  resetLink: string;
  expiresAt: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #f5f5f5; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .button { 
      background-color: #007bff; 
      color: white; 
      padding: 12px 24px; 
      text-decoration: none; 
      border-radius: 4px; 
      display: inline-block; 
      margin: 20px 0;
    }
    .warning { 
      background-color: #fff3cd; 
      border: 1px solid #ffc107; 
      padding: 10px; 
      border-radius: 4px; 
      margin: 15px 0;
    }
    .footer { 
      font-size: 12px; 
      color: #666; 
      text-align: center; 
      margin-top: 30px; 
      border-top: 1px solid #ddd; 
      padding-top: 15px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Iotistica</h1>
      <p>Set Your Admin Password</p>
    </div>

    <div class="content">
      <p>Hello ${options.customerName},</p>

      <p>Welcome to Iotistica! Your account has been provisioned and is ready to use. 
      To complete setup, you need to set your admin password by clicking the link below.</p>

      <a href="${options.resetLink}" class="button">Set Your Password</a>

      <div class="warning">
        <strong>⚠️ WARNING:</strong> This link will expire in 24 hours. 
        After that, you will need to use the password reset feature to set a new password.
      </div>

      <p><strong>Link expires:</strong> ${options.expiresAt}</p>

      <p><strong>What happens next:</strong></p>
      <ol>
        <li>Click the button above</li>
        <li>Create a strong password (minimum 12 characters)</li>
        <li>Log in with your email and new password</li>
        <li>Access your Iotistica dashboard</li>
      </ol>

      <p>If you did not sign up for this account, please contact support@iotistica.com.</p>

      <div class="footer">
        <p>© 2026 Iotistica Inc. All rights reserved.</p>
        <p><a href="https://iotistica.com">www.iotistica.com</a></p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Start email worker (call from main worker process)
 */
export function startEmailWorker() {
  const queue = emailQueue.getQueue();

  queue.process('send-admin-password-reset-link', async (job) => {
    return processSendPasswordResetLinkJob(job);
  });

  console.log('📧 Email worker started - listening for jobs...');
}

import { EmailTemplate } from '../types';

export const VerifyEmail: EmailTemplate = {
  subject: 'Please verify your email address',
  text: `Hello, {{safeName.text}},

Please use this code to verify your email address:

{{token.token}}

Do not share this code with anyone else.

This token will expire in 30 minutes.
`,
  html: `<p>Hello, <b>{{safeName.html}}</b>,</p>
<p>Please use this code to verify your email address:</p>
<p><b>{{token.token}}</b></p>
<p>Do not share this code with anyone else.</p>
<p>This token will expire in 30 minutes.</p>
`
};

export const UserSuspended: EmailTemplate = {
  subject: 'Account Suspended',
  text: `Hello, {{safeName.text}},

Your account has been suspended.

Please contact support for more information.
`,
  html: `<p>Hello, <b>{{safeName.html}}</b>,</p>
<p>Your account has been suspended.</p>
<p>Please contact support for more information.</p>
`
};

export const InviteUser: EmailTemplate = {
  subject: `You've been invited to join {{companyName}} on Iotistica`,
  text: `Hello,

{{inviterName}} has invited you to join {{companyName}} on the Iotistica IoT Platform as a {{role}}.

Accept your invitation by clicking the link below:

{{inviteUrl}}

This invitation will expire in 7 days.

If you were not expecting this invitation, you can safely ignore this email.
`,
  html: `<p>Hello,</p>
<p><b>{{inviterName}}</b> has invited you to join <b>{{companyName}}</b> on the Iotistica IoT Platform.</p>
<p>Your role will be: <b>{{role}}</b></p>
<p><a href="{{inviteUrl}}" style="display:inline-block;padding:12px 24px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Accept Invitation</a></p>
<p>Or copy this link into your browser:</p>
<p style="word-break:break-all;">{{inviteUrl}}</p>
<p style="color:#6b7280;font-size:14px;">This invitation expires in 7 days. If you were not expecting this, you can safely ignore this email.</p>
`
};
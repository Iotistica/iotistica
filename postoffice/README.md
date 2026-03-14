# PostOffice - Email Microservice

Standalone queue-based email delivery service for the Iotistic IoT platform. Handles transactional emails, notifications, and bulk email delivery with reliability and observability.

## Features

- **Multiple Transport Options**
  - SMTP (standard email servers)
  - AWS SES (Simple Email Service)
  - Configurable fallback strategies

- **Queue-Based Delivery**
  - Bull queue with Redis backend
  - Automatic retry with exponential backoff
  - Job prioritization and scheduling
  - Dead letter queue for failed emails

- **Template Engine**
  - Handlebars template rendering
  - Support for HTML and plain text emails
  - Dynamic variable substitution
  - Reusable email templates

- **Monitoring & Observability**
  - Bull Board UI for queue inspection
  - Database audit logging
  - Email delivery statistics
  - Real-time job status tracking
  - Optional Postgres-free mode (`EMAIL_LOG_BACKEND=none`)

- **REST API**
  - Send individual emails
  - Bulk email sending
  - Template-based emails
  - Email status queries

## Architecture

```
┌─────────────┐
│  API Client │
└──────┬──────┘
       │ POST /api/send
       ▼
┌─────────────────┐
│  PostOffice API │
└────────┬────────┘
         │
         ▼
┌────────────────┐      ┌──────────┐
│  Bull Queue    │◄────►│  Redis   │
│  (email jobs)  │      │  (state) │
└────────┬───────┘      └──────────┘
         │
         ▼
┌────────────────┐
│ Email Worker   │
│ (SMTP/SES)     │
└────────┬───────┘
         │
         ▼
┌────────────────┐      ┌──────────┐
│  Email Logger  │─────►│PostgreSQL│
│  (audit trail) │      │ (logs)   │
└────────────────┘      └──────────┘
```

## Quick Start

### Docker (Recommended)

```bash
# Using docker-compose (includes Redis and PostgreSQL)
docker-compose up -d postoffice

# Or build and run standalone
docker build -t iotistic-postoffice .
docker run -d \
  -p 3300:3300 \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_PORT=587 \
  -e SMTP_USER=user@example.com \
  -e SMTP_PASS=password \
  -e REDIS_HOST=redis \
  -e DB_HOST=postgres \
  iotistic-postoffice
```

### Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Run in development mode
npm run dev

# Build for production
npm run build
npm start
```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | HTTP server port | `3300` | No |
| `HOST` | HTTP server host | `0.0.0.0` | No |
| `EMAIL_ENABLED` | Enable/disable email sending | `true` | No |
| `EMAIL_FROM` | Default sender address | `"Iotistic Platform <noreply@iotistic.cloud>"` | No |
| `EMAIL_DEBUG` | Enable debug logging | `false` | No |
| `BASE_URL` | Base URL for email links | `https://iotistic.ca` | Yes |

#### SMTP Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `SMTP_HOST` | SMTP server hostname | Yes (for SMTP) |
| `SMTP_PORT` | SMTP server port | Yes (for SMTP) |
| `SMTP_SECURE` | Use TLS/SSL | No (default: `false`) |
| `SMTP_USER` | SMTP username | Yes (for SMTP) |
| `SMTP_PASS` | SMTP password | Yes (for SMTP) |

#### AWS SES Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `AWS_REGION` | AWS region (e.g., `us-east-1`) | Yes (for SES) |
| `AWS_ACCESS_KEY_ID` | AWS access key | Yes (for SES) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Yes (for SES) |

#### Redis Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `REDIS_HOST` | Redis hostname | `redis` | Yes |
| `REDIS_PORT` | Redis port | `6379` | No |
| `REDIS_PASSWORD` | Redis password | - | No |

#### Email Log Backend

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `EMAIL_LOG_BACKEND` | Email log persistence backend (`postgres` or `none`) | `none` | No |

When `EMAIL_LOG_BACKEND=none`, PostOffice runs without any PostgreSQL connection.
Email sending, queueing, retries, and Bull Board remain available.
`/api/email/logs*` endpoints return `503` because persistent audit logs are disabled.

#### Database Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB_HOST` | PostgreSQL hostname | `postgres` | Yes |
| `DB_PORT` | PostgreSQL port | `5432` | No |
| `DB_NAME` | Database name | `iotistic` | No |
| `DB_USER` | Database user | `postgres` | No |
| `DB_PASSWORD` | Database password | `postgres` | Yes |
| `LOG_LEVEL` | Logging level | `info` | No |

These DB variables are only required when `EMAIL_LOG_BACKEND=postgres`.

## API Reference

### Send Email

Send a single email with or without template.

```http
POST /api/send
Content-Type: application/json

{
  "to": "user@example.com",
  "subject": "Welcome to Iotistic",
  "template": "welcome",
  "context": {
    "name": "John Doe",
    "activationLink": "https://iotistic.ca/activate/abc123"
  }
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "email:12345",
  "message": "Email queued successfully"
}
```

### Send Bulk Emails

Send multiple emails in one request.

```http
POST /api/send/bulk
Content-Type: application/json

{
  "emails": [
    {
      "to": "user1@example.com",
      "subject": "Subject 1",
      "template": "newsletter",
      "context": { "name": "User 1" }
    },
    {
      "to": "user2@example.com",
      "subject": "Subject 2",
      "template": "newsletter",
      "context": { "name": "User 2" }
    }
  ]
}
```

### Get Email Status

Check the status of a sent email.

```http
GET /api/email/:logId
```

**Response:**
```json
{
  "id": "123",
  "recipient": "user@example.com",
  "subject": "Welcome to Iotistic",
  "status": "sent",
  "sentAt": "2025-11-14T12:00:00Z",
  "template": "welcome"
}
```

### Get Email Statistics

Retrieve email delivery statistics.

```http
GET /api/stats?days=7
```

**Response:**
```json
{
  "total": 1250,
  "sent": 1200,
  "failed": 50,
  "successRate": 96.0,
  "period": "7 days"
}
```

### Health Check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-14T12:00:00Z",
  "uptime": 3600,
  "redis": "connected",
  "database": "connected"
}
```

## Queue Monitoring

Access the Bull Board UI for queue monitoring:

```
http://localhost:3300/admin/queues
```

Features:
- View pending, active, completed, and failed jobs
- Retry failed jobs
- Clean old jobs
- Real-time job progress
- Job details and error messages

## Email Templates

Templates are stored in `src/templates/` and use Handlebars syntax.

### Creating a Template

1. Create HTML template: `src/templates/my-template.hbs`

```handlebars
<!DOCTYPE html>
<html>
<head>
  <title>{{subject}}</title>
</head>
<body>
  <h1>Hello {{name}}!</h1>
  <p>{{message}}</p>
  <a href="{{actionUrl}}">Click here</a>
</body>
</html>
```

2. Use in API call:

```javascript
{
  "template": "my-template",
  "context": {
    "subject": "My Subject",
    "name": "John",
    "message": "Welcome!",
    "actionUrl": "https://example.com/action"
  }
}
```

### Available Templates

- `welcome.hbs` - User welcome email
- `password-reset.hbs` - Password reset email
- `device-alert.hbs` - Device alert notification
- `report.hbs` - Periodic report email

## Database Schema

### email_logs Table

```sql
CREATE TABLE email_logs (
  id SERIAL PRIMARY KEY,
  recipient VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  template VARCHAR(100),
  status VARCHAR(50) NOT NULL,
  error TEXT,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Logging

Logs are written to stdout in JSON format for container environments.

**Log Levels:**
- `error` - Email delivery failures, system errors
- `warn` - Retry attempts, configuration issues
- `info` - Email sent, queue status
- `debug` - Detailed email processing

**Example Log:**
```json
{
  "level": "info",
  "message": "Email sent successfully",
  "recipient": "user@example.com",
  "subject": "Welcome",
  "jobId": "12345",
  "timestamp": "2025-11-14T12:00:00Z"
}
```

## Performance

- **Throughput**: 100+ emails/minute (SMTP), 1000+ emails/minute (SES)
- **Retry Strategy**: 3 attempts with exponential backoff (1min, 5min, 15min)
- **Queue Concurrency**: 10 concurrent workers (configurable)
- **Memory**: ~150MB idle, ~300MB under load

## Security

- **Non-root Container**: Runs as `postofficeuser` (UID 1000+)
- **No Secrets in Logs**: Email content and credentials redacted
- **TLS Support**: SMTP with STARTTLS
- **Rate Limiting**: Configurable per-user limits
- **Input Validation**: Email address and template validation

## Troubleshooting

### Emails Not Sending

1. Check Redis connection:
   ```bash
   docker logs iotistic-postoffice | grep redis
   ```

2. Verify SMTP credentials:
   ```bash
   docker exec -it iotistic-postoffice env | grep SMTP
   ```

3. Check failed jobs in Bull Board:
   ```
   http://localhost:3300/admin/queues
   ```

### Queue Stuck

Clear failed jobs:
```bash
curl -X DELETE http://localhost:3300/api/queue/clean/failed
```

### Database Connection Issues

Test connection:
```bash
docker exec -it iotistic-postoffice \
  node -e "require('./dist/db').testConnection()"
```

## Development

### Running Tests

```bash
npm test
```

### Code Structure

```
postoffice/
├── src/
│   ├── server.ts           # Main application entry
│   ├── index.ts            # PostOffice class
│   ├── email-logger.ts     # Database logging
│   ├── db.ts               # Database connection
│   ├── types.ts            # TypeScript types
│   ├── utils/
│   │   └── logger.ts       # Winston logger
│   └── templates/          # Email templates
├── migrations/             # Database migrations
├── Dockerfile              # Multi-stage production build
├── docker-compose.yml      # Local development stack
└── package.json
```

## License

Apache-2.0

## Support

For issues and questions:
- GitHub Issues: https://github.com/Iotistica/iotistic/issues
- Documentation: https://docs.iotistic.ca

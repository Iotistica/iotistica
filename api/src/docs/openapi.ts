/**
 * OpenAPI 3.0 Specification for Iotistic Unified API
 * Auto-generated documentation served via Swagger UI
 */

import { version } from '../../package.json';

const API_VERSION = process.env.API_VERSION || 'v1';
const API_BASE = `/api/${API_VERSION}`;

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Iotistic Unified API',
    version: version,
    description: `
# Iotistic Unified API

IoT device management, provisioning, and monitoring platform.

## Features

- 🔐 **Authentication & Authorization** - JWT-based authentication with OAuth2 support
- 📱 **Device Management** - Provision, monitor, and manage IoT agents
- 🎯 **Digital Twin** - Real-time device state synchronization
- 📊 **MQTT Monitoring** - Real-time MQTT message tracking and analytics
- 🔄 **OTA Updates** - Over-the-air firmware and application updates
- 🎫 **Licensing** - JWT-based device licensing system
- 📅 **Job Scheduling** - Schedule and execute device jobs
- 🔔 **Webhooks** - Event-driven notifications
- 📈 **Billing Integration** - Consumption-based billing tracking

## Authentication

Most endpoints require authentication via JWT tokens:

\`\`\`
Authorization: Bearer <token>
\`\`\`

Get a token via POST /api/v1/auth/login or /api/v1/auth/register.

## Rate Limiting

- **Anonymous**: 100 requests/15 minutes
- **Authenticated**: 1000 requests/15 minutes
- **Admin**: Unlimited

## Base URL

\`${API_BASE}\`
    `,
    contact: {
      name: 'Iotistic Support',
      email: 'support@iotistica.com'
    },
    license: {
      name: 'Proprietary',
      url: 'https://iotistica.com/license'
    }
  },
  servers: [
    {
      url: `http://localhost:3002${API_BASE}`,
      description: 'Development server'
    },
    {
      url: `https://api.iotistica.com${API_BASE}`,
      description: 'Production server'
    }
  ],
  tags: [
    {
      name: 'Authentication',
      description: 'User authentication and authorization endpoints'
    },
    {
      name: 'Devices',
      description: 'Device management and monitoring'
    },
    {
      name: 'Provisioning',
      description: 'Device provisioning and claiming'
    },
    {
      name: 'Digital Twin',
      description: 'Real-time device state management'
    },
    {
      name: 'Applications',
      description: 'Manage device applications and containers'
    },
    {
      name: 'Jobs',
      description: 'Device job scheduling and execution'
    },
    {
      name: 'Rollouts',
      description: 'OTA update management and deployment'
    },
    {
      name: 'MQTT',
      description: 'MQTT broker and monitoring'
    },
    {
      name: 'Webhooks',
      description: 'Event-driven webhook management'
    },
    {
      name: 'Licensing',
      description: 'Device licensing and validation'
    },
    {
      name: 'Billing',
      description: 'Usage tracking and billing'
    },
    {
      name: 'Admin',
      description: 'Administrative operations'
    },
    {
      name: 'Events',
      description: 'Event sourcing and audit logs'
    },
    {
      name: 'Graph',
      description: 'Entity relationship graph queries'
    }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token obtained from /auth/login or /auth/register'
      },
      deviceAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Device-UUID',
        description: 'Device UUID for device-specific operations'
      },
      adminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Key',
        description: 'Admin API key for privileged operations'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error type or category'
          },
          message: {
            type: 'string',
            description: 'Human-readable error message'
          },
          details: {
            type: 'object',
            description: 'Additional error details'
          }
        },
        required: ['error', 'message']
      },
      Device: {
        type: 'object',
        properties: {
          uuid: {
            type: 'string',
            format: 'uuid',
            description: 'Unique device identifier'
          },
          device_name: {
            type: 'string',
            description: 'Human-readable device name'
          },
          device_type: {
            type: 'string',
            description: 'Device type/model'
          },
          provisioning_state: {
            type: 'string',
            enum: ['PENDING', 'CLAIMED', 'PROVISIONED', 'DECOMMISSIONED'],
            description: 'Device provisioning status'
          },
          status: {
            type: 'string',
            description: 'Device operational status'
          },
          is_online: {
            type: 'boolean',
            description: 'Whether device is currently online'
          },
          ip_address: {
            type: 'string',
            nullable: true,
            description: 'Device IP address'
          },
          os_version: {
            type: 'string',
            nullable: true,
            description: 'Operating system version'
          },
          agent_version: {
            type: 'string',
            nullable: true,
            description: 'Device agent version'
          },
          cpu_usage: {
            type: 'number',
            nullable: true,
            description: 'CPU usage percentage'
          },
          memory_usage: {
            type: 'number',
            nullable: true,
            description: 'Memory usage in bytes'
          },
          created_at: {
            type: 'string',
            format: 'date-time',
            description: 'Device creation timestamp'
          }
        }
      },
      TargetState: {
        type: 'object',
        properties: {
          apps: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                image: { type: 'string' },
                env: { type: 'object' },
                networks: { type: 'array', items: { type: 'string' } },
                volumes: { type: 'array' }
              }
            },
            description: 'Application configurations'
          },
          config: {
            type: 'object',
            description: 'Device configuration'
          }
        }
      },
      CurrentState: {
        type: 'object',
        properties: {
          apps: {
            type: 'object',
            description: 'Currently running applications'
          },
          reported_at: {
            type: 'string',
            format: 'date-time',
            description: 'When state was last reported'
          }
        }
      },
      Job: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Job identifier'
          },
          agent_uuid: {
            type: 'string',
            format: 'uuid',
            description: 'Target device UUID'
          },
          operation: {
            type: 'string',
            description: 'Job operation type'
          },
          status: {
            type: 'string',
            enum: ['QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED'],
            description: 'Job execution status'
          },
          created_at: {
            type: 'string',
            format: 'date-time'
          },
          updated_at: {
            type: 'string',
            format: 'date-time'
          }
        }
      },
      License: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            description: 'JWT license token'
          },
          agent_uuid: {
            type: 'string',
            format: 'uuid'
          },
          features: {
            type: 'array',
            items: { type: 'string' },
            description: 'Enabled features'
          },
          expires_at: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'License expiration timestamp'
          }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: 'Authentication required or invalid token',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              error: 'Unauthorized',
              message: 'Invalid or missing authentication token'
            }
          }
        }
      },
      Forbidden: {
        description: 'Insufficient permissions',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              error: 'Forbidden',
              message: 'You do not have permission to access this resource'
            }
          }
        }
      },
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              error: 'Not found',
              message: 'The requested resource was not found'
            }
          }
        }
      },
      BadRequest: {
        description: 'Invalid request parameters',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              error: 'Bad Request',
              message: 'Invalid request parameters',
              details: {
                field: 'device_name',
                issue: 'Required field missing'
              }
            }
          }
        }
      },
      ServerError: {
        description: 'Internal server error',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              error: 'Internal Server Error',
              message: 'An unexpected error occurred'
            }
          }
        }
      }
    }
  },
  paths: {},
  security: []
};

export default openApiSpec;

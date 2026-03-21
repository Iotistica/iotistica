/**
 * API Routes Documentation
 * Define paths for OpenAPI spec
 */

export const paths = {
  // ============================================================================
  // Authentication
  // ============================================================================
  '/auth/register': {
    post: {
      tags: ['Authentication'],
      summary: 'Register new user',
      description: 'Create a new user account',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password', 'name'],
              properties: {
                email: {
                  type: 'string',
                  format: 'email',
                  example: 'user@example.com'
                },
                password: {
                  type: 'string',
                  minLength: 8,
                  example: 'SecurePass123!'
                },
                name: {
                  type: 'string',
                  example: 'John Doe'
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'User registered successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      email: { type: 'string' },
                      name: { type: 'string' }
                    }
                  },
                  token: {
                    type: 'string',
                    description: 'JWT authentication token'
                  }
                }
              }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/auth/login': {
    post: {
      tags: ['Authentication'],
      summary: 'User login',
      description: 'Authenticate and receive JWT token',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: {
                  type: 'string',
                  format: 'email',
                  example: 'user@example.com'
                },
                password: {
                  type: 'string',
                  example: 'SecurePass123!'
                }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Login successful',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  refreshToken: { type: 'string' },
                  expiresIn: { type: 'number' }
                }
              }
            }
          }
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/auth/refresh': {
    post: {
      tags: ['Authentication'],
      summary: 'Refresh access token',
      description: 'Get new access token using refresh token',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              properties: {
                refreshToken: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Token refreshed',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  expiresIn: { type: 'number' }
                }
              }
            }
          }
        },
        401: { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },

  // ============================================================================
  // Devices
  // ============================================================================
  '/agents': {
    get: {
      tags: ['Devices'],
      summary: 'List all agents',
      description: 'Get list of all registered agents with optional filtering',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'online',
          in: 'query',
          description: 'Filter by online status',
          required: false,
          schema: {
            type: 'boolean'
          }
        },
        {
          name: 'device_type',
          in: 'query',
          description: 'Filter by device type',
          required: false,
          schema: {
            type: 'string'
          }
        }
      ],
      responses: {
        200: {
          description: 'List of agents',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  count: { type: 'number' },
                  agents: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Device' }
                  }
                }
              }
            }
          }
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/agents/{uuid}': {
    get: {
      tags: ['Devices'],
      summary: 'Get device details',
      description: 'Retrieve detailed information about a specific device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          description: 'Device UUID',
          schema: {
            type: 'string',
            format: 'uuid'
          }
        }
      ],
      responses: {
        200: {
          description: 'Device details',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Device' }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' },
        401: { $ref: '#/components/responses/Unauthorized' }
      }
    },
    patch: {
      tags: ['Devices'],
      summary: 'Update device',
      description: 'Update device properties',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                device_name: { type: 'string' },
                device_type: { type: 'string' },
                note: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Device updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Device' }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' },
        401: { $ref: '#/components/responses/Unauthorized' }
      }
    },
    delete: {
      tags: ['Devices'],
      summary: 'Delete device',
      description: 'Permanently remove a device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      responses: {
        200: {
          description: 'Device deleted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' }
                }
              }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' },
        401: { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },

  // ============================================================================
  // Digital Twin
  // ============================================================================
  '/agents/{uuid}/state/target': {
    get: {
      tags: ['Digital Twin'],
      summary: 'Get device target state',
      description: 'Retrieve desired state configuration for device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      responses: {
        200: {
          description: 'Target state',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TargetState' }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' }
      }
    },
    put: {
      tags: ['Digital Twin'],
      summary: 'Set device target state',
      description: 'Update desired state for device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/TargetState' }
          }
        }
      },
      responses: {
        200: {
          description: 'Target state updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  state: { $ref: '#/components/schemas/TargetState' }
                }
              }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        404: { $ref: '#/components/responses/NotFound' }
      }
    }
  },

  '/agents/{uuid}/state/current': {
    get: {
      tags: ['Digital Twin'],
      summary: 'Get device current state',
      description: 'Retrieve actual reported state from device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      responses: {
        200: {
          description: 'Current state',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CurrentState' }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' }
      }
    }
  },

  // ============================================================================
  // Provisioning
  // ============================================================================
  '/provisioning/keys': {
    post: {
      tags: ['Provisioning'],
      summary: 'Generate provisioning key',
      description: 'Create a new device provisioning key',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                expiresAt: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true
                },
                deviceLimit: {
                  type: 'number',
                  nullable: true
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Provisioning key created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  id: { type: 'string' },
                  name: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time', nullable: true }
                }
              }
            }
          }
        },
        401: { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },

  '/provisioning/claim': {
    post: {
      tags: ['Provisioning'],
      summary: 'Claim device with provisioning key',
      description: 'Associate a device with user account using provisioning key',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['provisioningKey', 'deviceUuid'],
              properties: {
                provisioningKey: { type: 'string' },
                deviceUuid: { type: 'string', format: 'uuid' },
                deviceName: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Device claimed successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  device: { $ref: '#/components/schemas/Device' }
                }
              }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        404: { $ref: '#/components/responses/NotFound' }
      }
    }
  },

  // ============================================================================
  // Jobs
  // ============================================================================
  '/agents/{uuid}/jobs': {
    post: {
      tags: ['Jobs'],
      summary: 'Create device job',
      description: 'Schedule a job to execute on device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['operation'],
              properties: {
                operation: {
                  type: 'string',
                  enum: ['reboot', 'update', 'shutdown', 'restart-service', 'custom'],
                  description: 'Job operation type'
                },
                parameters: {
                  type: 'object',
                  description: 'Operation-specific parameters'
                },
                schedule: {
                  type: 'string',
                  description: 'Cron expression for scheduled execution',
                  nullable: true
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Job created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Job' }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        404: { $ref: '#/components/responses/NotFound' }
      }
    },
    get: {
      tags: ['Jobs'],
      summary: 'List device jobs',
      description: 'Get all jobs for a device',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'uuid',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' }
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']
          }
        }
      ],
      responses: {
        200: {
          description: 'List of jobs',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  jobs: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Job' }
                  }
                }
              }
            }
          }
        },
        404: { $ref: '#/components/responses/NotFound' }
      }
    }
  },

  // ============================================================================
  // Licensing
  // ============================================================================
  '/license/generate': {
    post: {
      tags: ['Licensing'],
      summary: 'Generate device license',
      description: 'Create JWT license token for device',
      security: [{ adminKey: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['deviceUuid'],
              properties: {
                deviceUuid: { type: 'string', format: 'uuid' },
                features: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['ota-updates', 'remote-access', 'analytics']
                },
                expiresIn: {
                  type: 'string',
                  description: 'Duration (e.g., "30d", "1y")',
                  example: '365d'
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'License generated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/License' }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        403: { $ref: '#/components/responses/Forbidden' }
      }
    }
  },

  '/license/validate': {
    post: {
      tags: ['Licensing'],
      summary: 'Validate license',
      description: 'Check if license token is valid',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: {
                token: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'License validation result',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  valid: { type: 'boolean' },
                  features: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  expiresAt: {
                    type: 'string',
                    format: 'date-time',
                    nullable: true
                  }
                }
              }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' }
      }
    }
  }
};

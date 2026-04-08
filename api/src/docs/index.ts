/**
 * API Documentation Server
 *
 * Provides multiple documentation interfaces:
 * - Swagger UI (OpenAPI 3.0) via @fastify/swagger + @fastify/swagger-ui
 * - ReDoc (alternative beautiful docs)
 * - RapiDoc (interactive API console)
 * - Postman collection export
 */

import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { openApiSpec } from './openapi';
import { paths } from './routes';
import logger from '../utils/logger';

const runtimeRequire = createRequire(__filename);
let hasWarnedAboutMissingDocsDependencies = false;

// Merge paths into spec
const completeSpec = {
  ...openApiSpec,
  paths
};

function areApiDocsDependenciesAvailable(): boolean {
  try {
    runtimeRequire.resolve('@fastify/swagger');
    runtimeRequire.resolve('@fastify/swagger-ui');
    return true;
  } catch (error) {
    if (!hasWarnedAboutMissingDocsDependencies) {
      hasWarnedAboutMissingDocsDependencies = true;
      logger.warn('API documentation requested but Swagger dependencies are unavailable; disabling docs at runtime', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return false;
  }
}

export function areApiDocsEnabled(): boolean {
  const docsEnabledByConfig = process.env.API_DOCS_ENABLED !== undefined
    ? process.env.API_DOCS_ENABLED === 'true'
    : process.env.NODE_ENV !== 'production';

  if (!docsEnabledByConfig) {
    return false;
  }

  return areApiDocsDependenciesAvailable();
}

export async function setupApiDocs(fastify: FastifyInstance, basePath: string = '/api/v1'): Promise<void> {
  if (!areApiDocsEnabled()) {
    logger.info('API documentation disabled');
    return;
  }

  let swagger: typeof import('@fastify/swagger').default;
  let swaggerUi: typeof import('@fastify/swagger-ui').default;

  try {
    [{ default: swagger }, { default: swaggerUi }] = await Promise.all([
      import('@fastify/swagger'),
      import('@fastify/swagger-ui'),
    ]);
  } catch (error) {
    logger.warn('Failed to load Swagger modules at runtime; API documentation will remain disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Register the spec (static mode — we maintain our own openapi spec)
  await fastify.register(swagger, {
    mode: 'static',
    specification: {
      document: completeSpec as any
    }
  });

  // Swagger UI at /api/docs
  await fastify.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true
    },
    theme: {
      css: [
        { filename: 'custom.css', content: '.swagger-ui .topbar { display: none } .swagger-ui .info { margin: 20px 0 } .swagger-ui .scheme-container { background: #1b1b1b; padding: 20px; margin: 20px 0; }' }
      ]
    }
  });

  // ReDoc
  fastify.get('/api/docs/redoc', async (_request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html>
  <head>
    <title>Iotistic API Documentation - ReDoc</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url='/api/docs/openapi.json'></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
  });

  // RapiDoc
  fastify.get('/api/docs/rapidoc', async (_request, reply) => {
    return reply.type('text/html').send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Iotistic API - RapiDoc</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script type="module" src="https://unpkg.com/rapidoc/dist/rapidoc-min.js"></script>
  </head>
  <body>
    <rapi-doc spec-url="/api/docs/openapi.json" theme="dark" bg-color="#1a1a1a" text-color="#f0f0f0"
      primary-color="#4a90e2" render-style="read" show-header="true" show-info="true"
      allow-try="true" allow-server-selection="true" allow-authentication="true"
      allow-schema-description-expand-toggle="true" schema-style="table"
      schema-expand-level="1" default-schema-tab="model" response-area-height="400px"
      show-method-in-nav-bar="as-colored-block" use-path-in-nav-bar="true">
      <div slot="logo" style="display: flex; align-items: center; padding: 10px;">
        <span style="font-size: 1.5em; font-weight: bold; color: #4a90e2;">Iotistic API</span>
      </div>
    </rapi-doc>
  </body>
</html>`);
  });

  // OpenAPI JSON (also served at /api/docs/json by @fastify/swagger-ui, kept for backward compat)
  fastify.get('/api/docs/openapi.json', async (_request, reply) => {
    return reply.send(completeSpec);
  });

  // Postman Collection export
  fastify.get('/api/docs/postman', async (_request, reply) => {
    return reply.send(convertToPostman(completeSpec));
  });

  // Documentation landing page
  fastify.get('/api/docs/index', async (_request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Iotistic API Documentation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
               background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;
               display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 60px; max-width: 800px;
                     box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #333; font-size: 2.5em; margin-bottom: 10px; }
        .subtitle { color: #666; font-size: 1.2em; margin-bottom: 40px; }
        .options { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 40px 0; }
        .option { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px;
                  border-radius: 10px; text-decoration: none; transition: transform 0.3s, box-shadow 0.3s; display: block; }
        .option:hover { transform: translateY(-5px); box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .option h2 { font-size: 1.5em; margin-bottom: 10px; }
        .option p { opacity: 0.9; line-height: 1.6; }
        .downloads { margin-top: 40px; padding-top: 40px; border-top: 1px solid #eee; }
        .downloads h3 { color: #333; margin-bottom: 20px; }
        .download-btn { display: inline-block; background: #4CAF50; color: white; padding: 12px 24px;
                        border-radius: 5px; text-decoration: none; margin-right: 10px; margin-bottom: 10px; transition: background 0.3s; }
        .download-btn:hover { background: #45a049; }
        .info { background: #f5f5f5; padding: 20px; border-radius: 10px; margin-top: 30px; }
        .info code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Iotistic API</h1>
        <p class="subtitle">Choose your preferred documentation interface</p>
        <div class="options">
            <a href="/api/docs" class="option"><h2>Swagger UI</h2><p>Interactive API documentation with try-it-out functionality.</p></a>
            <a href="/api/docs/redoc" class="option"><h2>ReDoc</h2><p>Beautiful, responsive documentation with a three-panel layout.</p></a>
            <a href="/api/docs/rapidoc" class="option"><h2>RapiDoc</h2><p>Modern, customizable API console with dark mode.</p></a>
        </div>
        <div class="downloads">
            <h3>Download Specifications</h3>
            <a href="/api/docs/openapi.json" class="download-btn">OpenAPI 3.0 JSON</a>
            <a href="/api/docs/postman" class="download-btn">Postman Collection</a>
        </div>
        <div class="info">
            <h3 style="color: #333; margin-bottom: 10px;">Quick Start</h3>
            <p style="color: #666; line-height: 1.8;">
                <strong>Base URL:</strong> <code>${basePath}</code><br>
                <strong>Authentication:</strong> Include JWT token in <code>Authorization: Bearer &lt;token&gt;</code> header<br>
                <strong>Get Token:</strong> POST to <code>/auth/login</code> or <code>/auth/register</code>
            </p>
        </div>
    </div>
</body>
</html>`);
  });

  logger.info('API Documentation available at:');
  logger.info('   - Swagger UI:  http://localhost:' + (process.env.PORT || 3002) + '/api/docs');
  logger.info('   - ReDoc:       http://localhost:' + (process.env.PORT || 3002) + '/api/docs/redoc');
  logger.info('   - RapiDoc:     http://localhost:' + (process.env.PORT || 3002) + '/api/docs/rapidoc');
  logger.info('   - Landing:     http://localhost:' + (process.env.PORT || 3002) + '/api/docs/index');
}
/**
 * Convert OpenAPI spec to Postman Collection v2.1
 */
function convertToPostman(spec: any): any {
  const collection: any = {
    info: {
      name: spec.info.title,
      description: spec.info.description,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      version: spec.info.version
    },
    auth: {
      type: 'bearer',
      bearer: [
        {
          key: 'token',
          value: '{{jwt_token}}',
          type: 'string'
        }
      ]
    },
    variable: [
      {
        key: 'baseUrl',
        value: spec.servers?.[0]?.url || 'http://localhost:3002/api/v1',
        type: 'string'
      },
      {
        key: 'jwt_token',
        value: '',
        type: 'string'
      }
    ],
    item: []
  };

  // Group requests by tags
  const tagGroups: Record<string, any[]> = {};

  Object.entries(spec.paths).forEach(([path, methods]: [string, any]) => {
    Object.entries(methods).forEach(([method, operation]: [string, any]) => {
      const tag = operation.tags?.[0] || 'Ungrouped';

      if (!tagGroups[tag]) {
        tagGroups[tag] = [];
      }

      const request: any = {
        name: operation.summary || `${method.toUpperCase()} ${path}`,
        request: {
          method: method.toUpperCase(),
          header: [
            {
              key: 'Content-Type',
              value: 'application/json'
            }
          ],
          url: {
            raw: `{{baseUrl}}${path}`,
            host: ['{{baseUrl}}'],
            path: path.split('/').filter(p => p)
          }
        }
      };

      // Add request body if present
      if (operation.requestBody) {
        const schema = operation.requestBody.content?.['application/json']?.schema;
        if (schema) {
          request.request.body = {
            mode: 'raw',
            raw: JSON.stringify(generateExampleFromSchema(schema), null, 2),
            options: {
              raw: {
                language: 'json'
              }
            }
          };
        }
      }

      // Add query parameters
      if (operation.parameters) {
        const queryParams = operation.parameters
          .filter((p: any) => p.in === 'query')
          .map((p: any) => ({
            key: p.name,
            value: p.example || '',
            description: p.description
          }));

        if (queryParams.length > 0) {
          request.request.url.query = queryParams;
        }
      }

      tagGroups[tag].push(request);
    });
  });

  // Convert tag groups to folders
  collection.item = Object.entries(tagGroups).map(([tag, requests]) => ({
    name: tag,
    item: requests
  }));

  return collection;
}

/**
 * Generate example JSON from OpenAPI schema
 */
function generateExampleFromSchema(schema: any): any {
  if (schema.example) return schema.example;
  if (schema.type === 'object') {
    const obj: any = {};
    if (schema.properties) {
      Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
        obj[key] = prop.example || generateExampleFromSchema(prop);
      });
    }
    return obj;
  }
  if (schema.type === 'array') {
    return schema.items ? [generateExampleFromSchema(schema.items)] : [];
  }
  if (schema.type === 'string') return schema.example || 'string';
  if (schema.type === 'number') return schema.example || 0;
  if (schema.type === 'boolean') return schema.example || false;
  return null;
}

export { completeSpec as openApiSpec };

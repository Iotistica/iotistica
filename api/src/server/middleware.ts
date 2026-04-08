/**
 * General application hooks: body parsing and related request preprocessing.
 *
 * Request IDs and request/response logging are handled by Fastify itself via the
 * factory options configured in server/app.ts.
 */

import type { FastifyInstance } from 'fastify';


export async function applyMiddleware(fastify: FastifyInstance): Promise<void> {

  // Fastify handles JSON and URL-encoded bodies natively.
  // Body limit: 16MB (handles large compressed log batches)
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (err: any) {
        const e = new Error(`Invalid JSON body: ${err.message}`) as any;
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 * 1024 },
    (_req, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (err: any) {
        done(err, undefined);
      }
    },
  );
  fastify.addContentTypeParser(
    'application/x-ndjson',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );
  fastify.addContentTypeParser(
    'text/plain',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );
}

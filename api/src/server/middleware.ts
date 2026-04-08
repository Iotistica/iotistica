/**
 * General application hooks: body parsing (built-in Fastify), brotli decompression,
 * traffic logging, and Winston request logging.
 *
 * Note: Request ID is handled automatically by Fastify via the `requestIdHeader`
 * and `genReqId` options passed to the Fastify factory — no custom middleware needed.
 */

import type { FastifyInstance } from 'fastify';
import { registerRequestLogger } from '../middleware/request-logger';


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


  // Winston per-request logging (skips 200s to reduce noise)
  registerRequestLogger(fastify);
}

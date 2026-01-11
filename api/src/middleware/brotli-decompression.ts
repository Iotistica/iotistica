import { Request, Response, NextFunction } from 'express';
import { createBrotliDecompress } from 'zlib';
import { logger } from '../utils/logger';

/**
 * Brotli decompression middleware
 * Express only supports gzip/deflate out of the box, not Brotli (br).
 * This middleware intercepts br-encoded requests and pipes them through a decompression transform.
 * 
 * CRITICAL: Uses stream piping instead of buffering to avoid consuming the request stream
 * SECURITY: Protects against decompression bombs with size limits and timeouts
 * 
 * OPTIMIZATION: Skip for /device/:uuid/logs - those requests queue compressed data directly
 * to avoid event loop blocking from CPU-intensive decompression + JSON parsing
 */
export const brotliDecompressionMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const contentEncoding = req.headers['content-encoding'];
  
  // Skip Brotli middleware for log ingestion endpoint (handles compression in worker)
  if (req.path.match(/^\/api\/v\d+\/device\/[^/]+\/logs$/)) {
    return next();
  }
  
  // Only process Brotli-encoded requests
  if (contentEncoding !== 'br') {
    return next();
  }
  
  // SECURITY: Guard against decompression bomb attacks
  // Reject compressed payloads larger than 10MB to prevent tiny compressed → massive decompressed attacks
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 10 * 1024 * 1024) {
    logger.warn('Brotli payload too large - possible decompression bomb', {
      path: req.path,
      contentLength,
      ip: req.ip
    });
    return res.status(413).json({ error: 'Compressed payload too large (max 10MB)' });
  }
  
  logger.debug('Brotli-encoded request detected', {
    path: req.path,
    contentType: req.headers['content-type'],
    contentLength
  });
  
  // Create Brotli decompression transform stream
  const brotliStream = createBrotliDecompress();
  
  // SECURITY: Set timeout to prevent slow decompression attacks
  // NOTE: Increased to 120s because legitimate agent log batches (10MB compressed)
  // can take 60-90s to decompress on slow hardware. Monitor for abuse.
  const decompressTimeout = setTimeout(() => {
    logger.error('Brotli decompression timeout - possible attack', {
      path: req.path,
      ip: req.ip,
      contentLength
    });
    brotliStream.destroy(new Error('Decompression timeout'));
    if (!res.headersSent) {
      res.status(408).json({ error: 'Decompression timeout' });
    }
  }, 120000); // 120 second timeout for large log batches
  
  // Update headers to reflect decompressed state
  delete req.headers['content-encoding'];
  delete req.headers['content-length']; // Will be recalculated by body parser
  
  // Pipe request through Brotli decompression
  // This allows Express body parsers to read decompressed data
  req.pipe(brotliStream);
  
  // Replace req with decompressed stream for downstream middleware
  // This is the standard pattern for compression middleware
  (req as any).pipe = brotliStream.pipe.bind(brotliStream);
  (req as any).on = brotliStream.on.bind(brotliStream);
  (req as any).read = brotliStream.read.bind(brotliStream);
  (req as any).unpipe = brotliStream.unpipe.bind(brotliStream);
  
  brotliStream.on('error', (error: any) => {
    clearTimeout(decompressTimeout);
    logger.error('Brotli decompression error', { 
      error: error.message,
      path: req.path,
      ip: req.ip
    });
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid Brotli-compressed body' });
    }
  });
  
  brotliStream.on('end', () => {
    clearTimeout(decompressTimeout);
  });
  
  next();
};

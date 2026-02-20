/**
 * General Purpose Logger
 * Wrapper around Winston for application logging
 */

import winston from 'winston';
import path from 'path';

// Detect Kubernetes environment (KUBERNETES_SERVICE_HOST is auto-injected)
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'iotistic-api' },
  transports: []  // Start with empty transports
});

// Add file transports only if NOT in Kubernetes
if (!isKubernetes) {
  logger.add(new winston.transports.File({ 
    filename: path.join('logs', 'combined.log'),
    maxsize: 10485760, // 10MB
    maxFiles: 10,
    tailable: true
  }));
  logger.add(new winston.transports.File({ 
    filename: path.join('logs', 'error.log'),
    level: 'error',
    maxsize: 10485760,
    maxFiles: 5
  }));
}

// Always add console transport (required for Kubernetes)
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, service, operation, step, ...meta }) => {
      // Filter out 'service' and internal fields from meta
      const relevantMeta = Object.keys(meta).filter(key => 
        key !== 'timestamp' && key !== 'level' && key !== 'message'
      );
      
      // Build operation context (for human readability)
        let prefix = '';
        if (operation) {
          prefix = `[${operation}]`;
          if (step) {
            prefix += ` ${step} →`;
          }
          prefix += ' ';
        }
        
        const metaStr = relevantMeta.length > 0 
          ? ' ' + JSON.stringify(meta) 
          : '';
        
        return `${timestamp} [${level}]: ${prefix}${message}${metaStr}`;
      })
    )
  }));

// Helper functions for structured logging with visual grouping
export const logOperation = {
  // Start an operation
  start: (operation: string, message: string, meta?: Record<string, any>) => {
    logger.info(message, { ...meta, operation, step: 'START' });
  },
  
  // Log a step within an operation
  step: (operation: string, message: string, meta?: Record<string, any>) => {
    logger.info(message, { ...meta, operation });
  },
  
  // Complete an operation
  complete: (operation: string, message: string, meta?: Record<string, any>) => {
    logger.info(message, { ...meta, operation, step: 'DONE' });
  },
  
  // Error in an operation
  error: (operation: string, message: string, error: Error, meta?: Record<string, any>) => {
    logger.error(message, { ...meta, operation, step: 'ERROR', error: error.message, stack: error.stack });
  }
};

// Export logger as default
export default logger;

// Also export named
export { logger };


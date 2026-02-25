/**
 * Simple logger utility
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private format(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  }

  debug(message: string, meta?: any): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(this.format('debug', message, meta));
    }
  }

  info(message: string, meta?: any): void {
    console.log(this.format('info', message, meta));
  }

  warn(message: string, meta?: any): void {
    console.warn(this.format('warn', message, meta));
  }

  error(message: string, error?: Error | any): void {
    const meta = error instanceof Error 
      ? { message: error.message, stack: error.stack }
      : error;
    console.error(this.format('error', message, meta));
  }
}

export const logger = new Logger();

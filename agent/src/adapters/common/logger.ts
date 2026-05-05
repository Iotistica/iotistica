import { Logger } from '../types.js';

/**
 * Console Logger implementation
 */
export class ConsoleLogger implements Logger {
  private level: string;
  private enableConsole: boolean;

  constructor(level: string = 'info', enableConsole: boolean = true) {
    this.level = level;
    this.enableConsole = enableConsole;
  }

  private shouldLog(messageLevel: string): boolean {
    if (!this.enableConsole) return false;
    
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[messageLevel as keyof typeof levels] >= levels[this.level as keyof typeof levels];
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message), ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message), ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message), ...args);
    }
  }

  setLevel(level: string): void {
    this.level = level;
  }

  setConsoleEnabled(enabled: boolean): void {
    this.enableConsole = enabled;
  }
}

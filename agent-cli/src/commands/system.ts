import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CLIError, logger } from '../core';


/**
 * iotctl logs [-f] [--lines <count>]
 */
export function showLogs(follow: boolean = false, lines: number = 50): void {
  throw new CLIError('Agent logs not available from inside container', 1, {
    note: 'Run from host machine instead',
    hint_docker: follow ? 'docker logs -f agent-1' : `docker logs --tail ${lines} agent-1`,
    hint_compose: follow ? 'docker-compose logs -f agent-1' : `docker-compose logs --tail=${lines} agent-1`,
  });
}

/**
 * iotctl version
 */
export function showVersion(): void {
  const possiblePaths = [
    join(__dirname, '..', 'package.json'),   // installed: /opt/iotistic/cli/dist/../package.json
    join(process.cwd(), 'package.json'),
    join(process.cwd(), '..', 'package.json'),
    '/app/package.json',
  ];

  for (const packagePath of possiblePaths) {
    try {
      if (existsSync(packagePath)) {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
        logger.info('iotctl - IoT Control CLI', { version: packageJson.version });
        return;
      }
    } catch {
      continue;
    }
  }

  logger.info('iotctl - IoT Control CLI', { version: '1.0.0' });
}

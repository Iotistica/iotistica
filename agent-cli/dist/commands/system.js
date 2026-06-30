"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showLogs = showLogs;
exports.showVersion = showVersion;
const fs_1 = require("fs");
const path_1 = require("path");
const core_1 = require("../core");
/**
 * iotctl logs [-f] [--lines <count>]
 */
function showLogs(follow = false, lines = 50) {
    throw new core_1.CLIError('Agent logs not available from inside container', 1, {
        note: 'Run from host machine instead',
        hint_docker: follow ? 'docker logs -f agent-1' : `docker logs --tail ${lines} agent-1`,
        hint_compose: follow ? 'docker-compose logs -f agent-1' : `docker-compose logs --tail=${lines} agent-1`,
    });
}
/**
 * iotctl version
 */
function showVersion() {
    const possiblePaths = [
        (0, path_1.join)(__dirname, '..', 'package.json'), // installed: /opt/iotistic/cli/dist/../package.json
        (0, path_1.join)(process.cwd(), 'package.json'),
        (0, path_1.join)(process.cwd(), '..', 'package.json'),
        '/app/package.json',
    ];
    for (const packagePath of possiblePaths) {
        try {
            if ((0, fs_1.existsSync)(packagePath)) {
                const packageJson = JSON.parse((0, fs_1.readFileSync)(packagePath, 'utf-8'));
                core_1.logger.info('iotctl - IoT Control CLI', { version: packageJson.version });
                return;
            }
        }
        catch {
            continue;
        }
    }
    core_1.logger.info('iotctl - IoT Control CLI', { version: '1.0.0' });
}
//# sourceMappingURL=system.js.map
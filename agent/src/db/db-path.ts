import path from 'path';
import * as fs from 'fs';

// Database path - auto-detect environment
// Docker: /app/data/agent.sqlite (matches volume mount)
// Local dev: ./data/agent.sqlite (relative to project root)
const getDefaultDatabasePath = (): string => {
	const isDocker = process.env.DEPLOYMENT_TYPE === 'docker';

	if (isDocker) {
		return '/app/data/agent.sqlite';
	}

	return path.join(process.cwd(), 'data', 'agent.sqlite');
};

// Explicit configuration beats auto-detection
// Edge rule: prefer DATABASE_PATH env var over heuristics
const databasePath = process.env.DATABASE_PATH || getDefaultDatabasePath();

// Ensure the data directory exists
const dataDir = path.dirname(databasePath);
if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

export function getDatabasePath(): string {
	return databasePath;
}
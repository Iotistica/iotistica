/**
 * Local web shell — WebSocket PTY handler.
 *
 * Attaches to the HTTP server's 'upgrade' event so it is handled before any
 * Express middleware. Auth is validated manually via the admin session cookie.
 *
 * Protocol (both directions are JSON-framed):
 *   client → server  { type: 'data',   data: string }     — keyboard input
 *   client → server  { type: 'resize', cols: N, rows: N } — terminal resize
 *   server → client  { type: 'data',   data: string }     — PTY output
 *   server → client  { type: 'exit',   code: N }          — process exited
 */

import type { Server, IncomingMessage } from 'http';
import { existsSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { AdminSessionModel } from '../db/models/admin-session.model.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

const SESSION_COOKIE = 'admin_session';

const SHELL_ALLOWLIST = [
	'/bin/bash', '/usr/bin/bash',
	'/bin/sh',   '/usr/bin/sh',
	'/bin/zsh',  '/usr/bin/zsh',
	'/bin/fish', '/usr/bin/fish',
];

function parseCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function authenticate(req: IncomingMessage): boolean {
	const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
	if (!token) return false;
	return !!AdminSessionModel.find(token);
}

function resolveShell(): string {
	const candidate = process.env.SHELL ?? '/bin/bash';
	if (SHELL_ALLOWLIST.includes(candidate) && existsSync(candidate)) return candidate;
	for (const s of ['/bin/bash', '/bin/sh']) {
		if (existsSync(s)) return s;
	}
	return '/bin/sh';
}

export function attachShellHandler(server: Server, logger?: AgentLogger): void {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req, socket, head) => {
		const url = req.url?.split('?')[0];
		if (url !== '/v1/shell') {
			socket.destroy();
			return;
		}

		if (!authenticate(req)) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
			socket.destroy();
			logger?.warnSync('Shell WebSocket rejected — invalid session', {
				component: LogComponents.agent,
				ip: (socket as any).remoteAddress,
			});
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
		const shell = resolveShell();
		const ip = (req.socket as any).remoteAddress ?? 'unknown';

		logger?.infoSync('Shell session opened', {
			component: LogComponents.agent,
			shell,
			ip,
		});

		let ptyProc: pty.IPty;
		try {
			ptyProc = pty.spawn(shell, [], {
				name: 'xterm-256color',
				cols: 80,
				rows: 24,
				cwd: process.env.HOME ?? '/',
				env: {
					TERM: 'xterm-256color',
					HOME: process.env.HOME ?? '/',
					PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
					USER: process.env.USER ?? 'iotistic',
					SHELL: shell,
					LANG: process.env.LANG ?? 'en_US.UTF-8',
				},
			});
		} catch (err) {
			logger?.errorSync('Failed to spawn PTY', err as Error, { component: LogComponents.agent });
			ws.close(1011, 'Failed to spawn shell');
			return;
		}

		ptyProc.onData((data: string) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'data', data }));
			}
		});

		ptyProc.onExit(({ exitCode }) => {
			logger?.infoSync('Shell session exited', { component: LogComponents.agent, exitCode, ip });
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
				ws.close();
			}
		});

		ws.on('message', (raw: Buffer | string) => {
			try {
				const msg = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
				if (msg.type === 'data' && typeof msg.data === 'string') {
					ptyProc.write(msg.data);
				} else if (msg.type === 'resize' && msg.cols && msg.rows) {
					ptyProc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
				}
			} catch { /* ignore malformed frames */ }
		});

		ws.on('close', () => {
			try { ptyProc.kill(); } catch { /* already dead */ }
			logger?.infoSync('Shell WebSocket closed', { component: LogComponents.agent, ip });
		});

		ws.on('error', () => {
			try { ptyProc.kill(); } catch { /* ignore */ }
		});
	});

	logger?.infoSync('Shell WebSocket handler attached at /v1/shell', { component: LogComponents.agent });
}

import mqtt, { type MqttClient } from 'mqtt';
import { EventEmitter } from 'events';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TopicNode {
  name: string;
  fullTopic: string;
  count: number;
  bytes: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
  messageType: 'json' | 'string' | 'binary';
  retain: boolean;
  qos: number;
  children: Record<string, TopicNode>;
}

export interface BrokerMetrics {
  connected: boolean;
  version: string;
  clients: {
    connected: number;
    total: number;
    maximum: number;
  };
  messages: {
    received: number;
    sent: number;
    stored: number;
  };
  bytes: {
    received: number;
    sent: number;
  };
  subscriptions: number;
  retainedMessages: number;
  uptime: number;
  messageRateIn: number;   // msgs/s received (5s rolling)
  messageRateOut: number;  // msgs/s sent (5s rolling)
  throughputIn: number;    // KB/s received (5s rolling)
  throughputOut: number;   // KB/s sent (5s rolling)
}

export interface BrokerStatus {
  connected: boolean;
  topicCount: number;
  messageCount: number;
  monitoringTopics: string[];
}

interface RateSample {
  ts: number;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 64 * 1024;  // truncate stored payload at 64KB
const RATE_SAMPLE_INTERVAL = 5000;   // sample rates every 5s
const MAX_RATE_SAMPLES = 12;         // keep 1 minute of samples
const MONITOR_CLIENT_ID = `iotistica-monitor-${Math.random().toString(36).slice(2, 8)}`;

// ── BrokerMonitorService ───────────────────────────────────────────────────────

export class BrokerMonitorService extends EventEmitter {
	private static instance: BrokerMonitorService | null = null;

	private client: MqttClient | null = null;
	private topicTree: Record<string, TopicNode> = {};
	private sysData: Record<string, string> = {};
	private totalTopics = 0;
	private totalMessages = 0;
	private rateSamples: RateSample[] = [];
	private rateTimer: NodeJS.Timeout | null = null;
	private _connected = false;
	private brokerUrl: string;
	private username: string;
	private password: string;

	private constructor() {
		super();
		this.brokerUrl = process.env.LOCAL_MQTT_URL ?? 'mqtt://localhost:1883';
		this.username  = process.env.LOCAL_MQTT_USER ?? 'admin';
		this.password  = process.env.LOCAL_MQTT_PASS ?? process.env.MQTT_PASSWORD ?? '';
	}

	static getInstance(): BrokerMonitorService {
		if (!BrokerMonitorService.instance) {
			BrokerMonitorService.instance = new BrokerMonitorService();
		}
		return BrokerMonitorService.instance;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────────

	start(): void {
		if (this.client) return;

		const options: mqtt.IClientOptions = {
			clientId: MONITOR_CLIENT_ID,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 10000,
			...(this.username ? { username: this.username, password: this.password } : {}),
		};

		this.client = mqtt.connect(this.brokerUrl, options);

		this.client.on('connect', () => {
			this._connected = true;
      this.client!.subscribe(['#', '$SYS/#'], { qos: 0 }, () => {});
      this.emit('connect');
		});

		this.client.on('disconnect', () => {
			this._connected = false;
		});

		this.client.on('error', () => {
			this._connected = false;
		});

		this.client.on('offline', () => {
			this._connected = false;
		});

		this.client.on('message', (topic, payload, packet) => {
			this.handleMessage(topic, payload, packet);
		});

		this.rateTimer = setInterval(() => this.sampleRates(), RATE_SAMPLE_INTERVAL);
	}

	stop(): void {
		if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
		this.client?.end(true);
		this.client = null;
		this._connected = false;
	}

	// ── Message handling ──────────────────────────────────────────────────────────

	private handleMessage(topic: string, payload: Buffer, packet: any): void {
		if (topic.startsWith('$SYS/')) {
			this.sysData[topic] = payload.toString('utf8');
			return;
		}
		// Skip our own monitor client's messages
		if (topic.startsWith(`$`)) return;

		const { text, type } = this.decodePayload(payload);
		this.upsertTopic(topic, text, type, payload.length, packet);
		this.totalMessages++;
	}

	private decodePayload(payload: Buffer): { text: string; type: 'json' | 'string' | 'binary' } {
		if (payload.length === 0) return { text: '', type: 'string' };

		const sample = payload.slice(0, MAX_MESSAGE_SIZE);
		const str = sample.toString('utf8');

		// Try JSON
		try {
			JSON.parse(str);
			return { text: str, type: 'json' };
		} catch { /* not JSON */ }

		// Printable string check
		const isPrintable = [...str].every(c => {
			const cp = c.charCodeAt(0);
			return cp >= 0x09 && cp <= 0x7e || cp >= 0x80;
		});
		if (isPrintable) return { text: str, type: 'string' };

		return { text: `<binary ${payload.length}B>`, type: 'binary' };
	}

	private upsertTopic(
		topic: string,
		message: string,
		messageType: 'json' | 'string' | 'binary',
		bytes: number,
		packet: any,
	): void {
		const parts = topic.split('/');
		let node = this.topicTree;
		let fullPath = '';

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			fullPath = fullPath ? `${fullPath}/${part}` : part;

			if (!node[part]) {
				node[part] = {
					name: part,
					fullTopic: fullPath,
					count: 0,
					bytes: 0,
					lastMessage: null,
					lastMessageAt: null,
					messageType: 'string',
					retain: false,
					qos: 0,
					children: {},
				};
				if (i === parts.length - 1) this.totalTopics++;
			}

			const current = node[part];
			if (i === parts.length - 1) {
				current.count++;
				current.bytes += bytes;
				current.lastMessage = message;
				current.lastMessageAt = Date.now();
				current.messageType = messageType;
				current.retain = packet.retain ?? false;
				current.qos = packet.qos ?? 0;
			}

			node = current.children;
		}
	}

	// ── Rate sampling ─────────────────────────────────────────────────────────────

	private sampleRates(): void {
		const received = parseInt(this.sysData['$SYS/broker/messages/received'] ?? '0', 10);
		const sent     = parseInt(this.sysData['$SYS/broker/messages/sent'] ?? '0', 10);
		const bytesIn  = parseInt(this.sysData['$SYS/broker/bytes/received'] ?? '0', 10);
		const bytesOut = parseInt(this.sysData['$SYS/broker/bytes/sent'] ?? '0', 10);

		this.rateSamples.push({ ts: Date.now(), messagesReceived: received, messagesSent: sent, bytesReceived: bytesIn, bytesSent: bytesOut });
		if (this.rateSamples.length > MAX_RATE_SAMPLES) this.rateSamples.shift();
	}

	private calcRate(getter: (s: RateSample) => number): number {
		if (this.rateSamples.length < 2) return 0;
		const oldest = this.rateSamples[0];
		const newest = this.rateSamples[this.rateSamples.length - 1];
		const dt = (newest.ts - oldest.ts) / 1000;
		if (dt <= 0) return 0;
		return Math.max(0, (getter(newest) - getter(oldest)) / dt);
	}

	// ── Public API ────────────────────────────────────────────────────────────────

	getStatus(): BrokerStatus {
		return {
			connected: this._connected,
			topicCount: this.totalTopics,
			messageCount: this.totalMessages,
			monitoringTopics: ['#', '$SYS/#'],
		};
	}

	getMetrics(): BrokerMetrics {
		const sys = this.sysData;
		return {
			connected: this._connected,
			version: sys['$SYS/broker/version'] ?? '',
			clients: {
				connected:  parseInt(sys['$SYS/broker/clients/connected']  ?? '0', 10),
				total:      parseInt(sys['$SYS/broker/clients/total']       ?? '0', 10),
				maximum:    parseInt(sys['$SYS/broker/clients/maximum']     ?? '0', 10),
			},
			messages: {
				received: parseInt(sys['$SYS/broker/messages/received'] ?? '0', 10),
				sent:     parseInt(sys['$SYS/broker/messages/sent']     ?? '0', 10),
				stored:   parseInt(sys['$SYS/broker/messages/stored']   ?? '0', 10),
			},
			bytes: {
				received: parseInt(sys['$SYS/broker/bytes/received'] ?? '0', 10),
				sent:     parseInt(sys['$SYS/broker/bytes/sent']     ?? '0', 10),
			},
			subscriptions:    parseInt(sys['$SYS/broker/subscriptions/count'] ?? '0', 10),
			retainedMessages: parseInt(sys["$SYS/broker/retained messages/count"] ?? '0', 10),
			uptime:           parseInt(sys['$SYS/broker/uptime'] ?? '0', 10),
			messageRateIn:    Math.round(this.calcRate(s => s.messagesReceived) * 10) / 10,
			messageRateOut:   Math.round(this.calcRate(s => s.messagesSent) * 10) / 10,
			throughputIn:     Math.round(this.calcRate(s => s.bytesReceived) / 1024 * 10) / 10,
			throughputOut:    Math.round(this.calcRate(s => s.bytesSent) / 1024 * 10) / 10,
		};
	}

	getTopicTree(): Record<string, TopicNode> {
		return this.topicTree;
	}

	reconfigure(url: string, username: string, password: string): void {
		this.brokerUrl = url;
		this.username  = username;
		this.password  = password;
		// Reconnect with new credentials
		this.stop();
		this.start();
	}

	getTopics(): Array<Omit<TopicNode, 'children'> & { children?: never }> {
		const result: Array<Omit<TopicNode, 'children'>> = [];
		const walk = (nodes: Record<string, TopicNode>) => {
			for (const node of Object.values(nodes)) {
				// Only include leaf nodes (actual topics with messages)
				if (node.count > 0) {
					const { children: _c, ...flat } = node;
					result.push(flat);
				}
				walk(node.children);
			}
		};
		walk(this.topicTree);
		return result.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
	}
}

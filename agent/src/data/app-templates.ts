export interface AppTemplateService {
	serviceName: string;
	image: string;
	ports?: string[];
	volumes?: string[];
	environment?: Record<string, string>;
	restart?: string;
}

export interface AppTemplate {
	id: string;
	name: string;
	category: string;
	description: string;
	color: string;
	letter: string;
	appName: string;
	services: AppTemplateService[];
}

export const APP_TEMPLATES: AppTemplate[] = [
	// ── Automation ──────────────────────────────────────────────────────────────
	{
		id: 'node-red',
		name: 'Node-RED',
		category: 'Automation',
		description: 'Low-code programming for event-driven IoT applications and automations.',
		color: '#8F0000',
		letter: 'NR',
		appName: 'node-red',
		services: [{
			serviceName: 'node-red',
			image: 'nodered/node-red:latest',
			ports: ['1880:1880'],
			volumes: ['node-red-data:/data'],
			environment: { TZ: 'UTC' },
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'home-assistant',
		name: 'Home Assistant',
		category: 'Automation',
		description: 'Open-source home automation platform running locally.',
		color: '#18BCF2',
		letter: 'HA',
		appName: 'home-assistant',
		services: [{
			serviceName: 'home-assistant',
			image: 'ghcr.io/home-assistant/home-assistant:stable',
			ports: ['8123:8123'],
			volumes: ['ha-config:/config'],
			environment: { TZ: 'UTC' },
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'n8n',
		name: 'n8n',
		category: 'Automation',
		description: 'Extendable workflow automation with 400+ integrations and a visual editor.',
		color: '#EA4B71',
		letter: 'n8',
		appName: 'n8n',
		services: [{
			serviceName: 'n8n',
			image: 'n8nio/n8n:latest',
			ports: ['5678:5678'],
			volumes: ['n8n-data:/home/node/.n8n'],
			restart: 'unless-stopped',
		}],
	},

	// ── Monitoring ──────────────────────────────────────────────────────────────
	{
		id: 'grafana',
		name: 'Grafana',
		category: 'Monitoring',
		description: 'Operational dashboards for time-series metrics from any data source.',
		color: '#F46800',
		letter: 'GF',
		appName: 'grafana',
		services: [{
			serviceName: 'grafana',
			image: 'grafana/grafana:latest',
			ports: ['3000:3000'],
			volumes: ['grafana-data:/var/lib/grafana'],
			environment: { GF_SECURITY_ADMIN_PASSWORD: 'admin' },
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'prometheus',
		name: 'Prometheus',
		category: 'Monitoring',
		description: 'Pull-based metrics collection and alerting toolkit.',
		color: '#E6522C',
		letter: 'PR',
		appName: 'prometheus',
		services: [{
			serviceName: 'prometheus',
			image: 'prom/prometheus:latest',
			ports: ['9090:9090'],
			volumes: ['prometheus-data:/prometheus'],
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'telegraf',
		name: 'Telegraf',
		category: 'Monitoring',
		description: 'Plugin-driven server agent for collecting and reporting metrics.',
		color: '#22ADF6',
		letter: 'TG',
		appName: 'telegraf',
		services: [{
			serviceName: 'telegraf',
			image: 'telegraf:latest',
			volumes: ['/etc/telegraf/telegraf.conf:/etc/telegraf/telegraf.conf:ro'],
			restart: 'unless-stopped',
		}],
	},

	// ── Time Series ─────────────────────────────────────────────────────────────
	{
		id: 'influxdb',
		name: 'InfluxDB',
		category: 'Time Series',
		description: 'Purpose-built time-series database for high-write sensor workloads.',
		color: '#9B19F5',
		letter: 'IF',
		appName: 'influxdb',
		services: [{
			serviceName: 'influxdb',
			image: 'influxdb:2',
			ports: ['8086:8086'],
			volumes: ['influxdb-data:/var/lib/influxdb2'],
			environment: {
				DOCKER_INFLUXDB_INIT_MODE: 'setup',
				DOCKER_INFLUXDB_INIT_USERNAME: 'admin',
				DOCKER_INFLUXDB_INIT_PASSWORD: 'adminadmin',
				DOCKER_INFLUXDB_INIT_ORG: 'iotistica',
				DOCKER_INFLUXDB_INIT_BUCKET: 'sensors',
			},
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'timescaledb',
		name: 'TimescaleDB',
		category: 'Time Series',
		description: 'PostgreSQL supercharged for time-series data — SQL with time-based partitioning.',
		color: '#FDB515',
		letter: 'TS',
		appName: 'timescaledb',
		services: [{
			serviceName: 'timescaledb',
			image: 'timescale/timescaledb:latest-pg16',
			ports: ['5432:5432'],
			volumes: ['timescale-data:/var/lib/postgresql/data'],
			environment: { POSTGRES_PASSWORD: 'postgres' },
			restart: 'unless-stopped',
		}],
	},

	// ── MQTT & Messaging ────────────────────────────────────────────────────────
	{
		id: 'mosquitto',
		name: 'Eclipse Mosquitto',
		category: 'MQTT',
		description: 'Lightweight MQTT broker ideal for IoT messaging on edge devices.',
		color: '#3C5A9A',
		letter: 'MQ',
		appName: 'mosquitto',
		services: [{
			serviceName: 'mosquitto',
			image: 'eclipse-mosquitto:2',
			ports: ['1883:1883', '9001:9001'],
			volumes: ['mosquitto-data:/mosquitto/data', 'mosquitto-log:/mosquitto/log'],
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'emqx',
		name: 'EMQX',
		category: 'MQTT',
		description: 'Scalable MQTT broker with built-in dashboard, rules engine, and clustering.',
		color: '#00B4A0',
		letter: 'EX',
		appName: 'emqx',
		services: [{
			serviceName: 'emqx',
			image: 'emqx:latest',
			ports: ['1883:1883', '8083:8083', '8084:8084', '18083:18083'],
			volumes: ['emqx-data:/opt/emqx/data'],
			restart: 'unless-stopped',
		}],
	},

	// ── Management ──────────────────────────────────────────────────────────────
	{
		id: 'portainer',
		name: 'Portainer CE',
		category: 'Management',
		description: 'Visual Docker management UI — containers, images, volumes, and networks.',
		color: '#13BEF9',
		letter: 'PT',
		appName: 'portainer',
		services: [{
			serviceName: 'portainer',
			image: 'portainer/portainer-ce:latest',
			ports: ['9000:9000', '9443:9443'],
			volumes: ['/var/run/docker.sock:/var/run/docker.sock', 'portainer-data:/data'],
			restart: 'unless-stopped',
		}],
	},

	// ── IoT Platform ────────────────────────────────────────────────────────────
	{
		id: 'zigbee2mqtt',
		name: 'Zigbee2MQTT',
		category: 'IoT Platform',
		description: 'Bridge Zigbee devices to MQTT — no proprietary hub needed.',
		color: '#238636',
		letter: 'Z2',
		appName: 'zigbee2mqtt',
		services: [{
			serviceName: 'zigbee2mqtt',
			image: 'koenkk/zigbee2mqtt:latest',
			ports: ['8080:8080'],
			volumes: ['zigbee2mqtt-data:/app/data', '/run/udev:/run/udev:ro'],
			environment: { TZ: 'UTC' },
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'frigate',
		name: 'Frigate NVR',
		category: 'IoT Platform',
		description: 'Local AI-powered network video recorder with real-time object detection.',
		color: '#1677ff',
		letter: 'FR',
		appName: 'frigate',
		services: [{
			serviceName: 'frigate',
			image: 'ghcr.io/blakeblackshear/frigate:stable',
			ports: ['5000:5000', '8554:8554', '8555:8555'],
			volumes: ['frigate-config:/config', 'frigate-media:/media/frigate'],
			environment: { TZ: 'UTC' },
			restart: 'unless-stopped',
		}],
	},

	// ── Database ────────────────────────────────────────────────────────────────
	{
		id: 'postgres',
		name: 'PostgreSQL',
		category: 'Database',
		description: 'Robust open-source relational database. The world\'s most advanced SQL database.',
		color: '#336791',
		letter: 'PG',
		appName: 'postgres',
		services: [{
			serviceName: 'postgres',
			image: 'postgres:16',
			ports: ['5432:5432'],
			volumes: ['postgres-data:/var/lib/postgresql/data'],
			environment: { POSTGRES_PASSWORD: 'postgres' },
			restart: 'unless-stopped',
		}],
	},
	{
		id: 'redis',
		name: 'Redis',
		category: 'Database',
		description: 'In-memory data structure store used as a cache, message broker, and queue.',
		color: '#DC382D',
		letter: 'RD',
		appName: 'redis',
		services: [{
			serviceName: 'redis',
			image: 'redis:7-alpine',
			ports: ['6379:6379'],
			volumes: ['redis-data:/data'],
			restart: 'unless-stopped',
		}],
	},

	// ── AI ──────────────────────────────────────────────────────────────────────
	{
		id: 'ollama',
		name: 'Ollama',
		category: 'AI',
		description: 'Run large language models locally — Llama 3, Mistral, Gemma, and more.',
		color: '#1a1a1a',
		letter: 'OL',
		appName: 'ollama',
		services: [{
			serviceName: 'ollama',
			image: 'ollama/ollama:latest',
			ports: ['11434:11434'],
			volumes: ['ollama-data:/root/.ollama'],
			restart: 'unless-stopped',
		}],
	},
];

export const TEMPLATE_CATEGORIES = [
	'All',
	...Array.from(new Set(APP_TEMPLATES.map(t => t.category))),
];

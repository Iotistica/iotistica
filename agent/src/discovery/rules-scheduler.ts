import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { DiscoveryService } from './service';
import { DiscoveryRuleModel, type DiscoveryRule } from '../db/models/discovery-rule.model';

const POLL_INTERVAL_MS = 30_000;

export class DiscoveryRulesScheduler {
	private logger?: AgentLogger;
	private discoveryService: DiscoveryService;
	private timer?: NodeJS.Timeout;

	constructor(discoveryService: DiscoveryService, logger?: AgentLogger) {
		this.discoveryService = discoveryService;
		this.logger = logger;
	}

	start(): void {
		this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
		this.logger?.infoSync('Discovery rules scheduler started', {
			component: LogComponents.agent,
			pollIntervalMs: POLL_INTERVAL_MS,
		});
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	async runNow(uuid: string): Promise<DiscoveryRule> {
		const rule = DiscoveryRuleModel.getByUuid(uuid);
		if (!rule) {
			throw Object.assign(new Error(`Discovery rule not found: ${uuid}`), { statusCode: 404 });
		}
		await this.executeRule(rule);
		return DiscoveryRuleModel.getByUuid(uuid)!;
	}

	private async tick(): Promise<void> {
		const due = DiscoveryRuleModel.getDue();
		for (const rule of due) {
			await this.executeRule(rule);
		}
	}

	private async executeRule(rule: DiscoveryRule): Promise<void> {
		const startedAt = new Date().toISOString();
		DiscoveryRuleModel.update(rule.uuid, { status: 'running', last_run_at: startedAt });

		this.logger?.infoSync('Discovery rule started', {
			component: LogComponents.agent,
			ruleUuid: rule.uuid,
			ruleName: rule.name,
			protocol: rule.protocol,
		});

		try {
			const devices = await this.discoveryService.runDiscovery({
				trigger: 'scheduled',
				protocols: [rule.protocol as any],
				forceRun: true,
				skipDbWrites: !rule.auto_enable,
				...(rule.params_json ? { optionOverrides: { [rule.protocol]: rule.params_json } } : {}),
			});

			const found = devices.length;
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();
			DiscoveryRuleModel.update(rule.uuid, {
				status: 'ok',
				last_result_json: { found, saved: rule.auto_enable ? found : 0, skipped: 0 },
				next_run_at: next,
			});

			this.logger?.infoSync('Discovery rule completed', {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
				found,
				autoEnable: rule.auto_enable,
				nextRunAt: next,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();
			DiscoveryRuleModel.update(rule.uuid, {
				status: 'error',
				last_result_json: { found: 0, saved: 0, skipped: 0, error: msg },
				next_run_at: next,
			});

			this.logger?.errorSync('Discovery rule failed', error instanceof Error ? error : new Error(msg), {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
			});
		}
	}
}

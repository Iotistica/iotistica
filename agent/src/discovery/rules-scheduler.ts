import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { DiscoveryService, DiscoveredDevice } from './service';
import { DiscoveryRuleModel, type DiscoveryRule } from '../db/models/discovery-rule.model';
import { DiscoveryRunModel } from '../db/models/discovery-run.model';

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
		// Reset any rules left in 'running' state from a previous interrupted session
		const stale = DiscoveryRuleModel.getAll().filter((r) => r.status === 'running');
		for (const rule of stale) {
			DiscoveryRuleModel.update(rule.uuid, {
				status: 'error',
				last_result_json: { found: 0, saved: 0, skipped: 0, error: 'interrupted by restart' },
			});
		}

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

	async runNow(uuid: string): Promise<{ rule: DiscoveryRule; devices: DiscoveredDevice[] }> {
		const rule = DiscoveryRuleModel.getByUuid(uuid);
		if (!rule) {
			throw Object.assign(new Error(`Discovery rule not found: ${uuid}`), { statusCode: 404 });
		}
		const devices = await this.executeRule(rule, 'manual');
		return { rule: DiscoveryRuleModel.getByUuid(uuid)!, devices };
	}

	private async tick(): Promise<void> {
		const due = DiscoveryRuleModel.getDue();
		for (const rule of due) {
			await this.executeRule(rule, 'scheduled');
		}
	}

	private async executeRule(rule: DiscoveryRule, trigger: 'scheduled' | 'manual'): Promise<DiscoveredDevice[]> {
		const startedAt = new Date().toISOString();
		DiscoveryRuleModel.update(rule.uuid, { status: 'running', last_run_at: startedAt });

		let runId: number | null = null;
		try {
			runId = DiscoveryRunModel.create({
				rule_uuid: rule.uuid,
				rule_name: rule.name,
				protocol:  rule.protocol,
				trigger,
				started_at: startedAt,
			});
		} catch {
			// non-fatal: run tracking unavailable (e.g. migration pending)
		}

		this.logger?.infoSync('Discovery rule started', {
			component: LogComponents.agent,
			ruleUuid: rule.uuid,
			ruleName: rule.name,
			protocol: rule.protocol,
			trigger,
		});

		let devices: DiscoveredDevice[] = [];
		try {
			devices = await this.discoveryService.runDiscovery({
				trigger: 'scheduled',
				protocols: [rule.protocol as any],
				forceRun: true,
				skipDbWrites: !rule.auto_enable,
				...(rule.params_json ? { optionOverrides: { [rule.protocol]: rule.params_json } } : {}),
			});

			const found = devices.length;
			const saved = rule.auto_enable ? found : 0;
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - new Date(startedAt).getTime();
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();

			DiscoveryRuleModel.update(rule.uuid, {
				status: 'ok',
				last_result_json: { found, saved, skipped: 0 },
				next_run_at: next,
			});
			if (runId !== null) {
				try { DiscoveryRunModel.finish(runId, { finished_at: finishedAt, duration_ms: durationMs, status: 'ok', found, saved, skipped: 0 }); } catch { /* non-fatal */ }
			}

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
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - new Date(startedAt).getTime();
			const next = new Date(Date.now() + rule.interval_seconds * 1000).toISOString();

			DiscoveryRuleModel.update(rule.uuid, {
				status: 'error',
				last_result_json: { found: 0, saved: 0, skipped: 0, error: msg },
				next_run_at: next,
			});
			if (runId !== null) {
				try { DiscoveryRunModel.finish(runId, { finished_at: finishedAt, duration_ms: durationMs, status: 'error', found: 0, saved: 0, skipped: 0, error: msg }); } catch { /* non-fatal */ }
			}

			this.logger?.errorSync('Discovery rule failed', error instanceof Error ? error : new Error(msg), {
				component: LogComponents.agent,
				ruleUuid: rule.uuid,
				ruleName: rule.name,
			});
		}

		return devices;
	}
}

import type { AgentLogger } from './logging/agent-logger.js';
import { LogComponents } from './logging/types.js';

export enum AgentState {
	BOOT = 'BOOT',
	INIT = 'INIT',
	READY = 'READY',
	RUNNING = 'RUNNING',
	STOPPING = 'STOPPING',
	STOPPED = 'STOPPED',
	ERROR = 'ERROR',
}

type LifecycleHook = () => Promise<void> | void;
type ErrorLifecycleHook = (context: { state: AgentState; error: unknown }) => Promise<void> | void;

const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
	[AgentState.BOOT]: [AgentState.INIT, AgentState.ERROR],
	[AgentState.INIT]: [AgentState.READY, AgentState.ERROR],
	[AgentState.READY]: [AgentState.RUNNING, AgentState.STOPPING, AgentState.ERROR],
	[AgentState.RUNNING]: [AgentState.STOPPING, AgentState.ERROR],
	[AgentState.STOPPING]: [AgentState.STOPPED, AgentState.ERROR],
	[AgentState.STOPPED]: [AgentState.INIT, AgentState.ERROR],
	[AgentState.ERROR]: [AgentState.INIT, AgentState.STOPPING],
};

export class AgentLifecycle {
	constructor(private logger?: AgentLogger) {}

	private state: AgentState = AgentState.BOOT;
	private transitioning = false;
	private readonly enterHooks = new Map<AgentState, LifecycleHook[]>();
	private readonly exitHooks = new Map<AgentState, LifecycleHook[]>();
	private readonly errorHooks: ErrorLifecycleHook[] = [];

	public setLogger(logger?: AgentLogger): void {
		this.logger = logger;
	}

	public getState(): AgentState {
		return this.state;
	}

	public canTransition(next: AgentState): boolean {
		return ALLOWED_TRANSITIONS[this.state].includes(next);
	}

	public onEnter(state: AgentState, hook: LifecycleHook): void {
		const hooks = this.enterHooks.get(state) ?? [];
		hooks.push(hook);
		this.enterHooks.set(state, hooks);
	}

	public onExit(state: AgentState, hook: LifecycleHook): void {
		const hooks = this.exitHooks.get(state) ?? [];
		hooks.push(hook);
		this.exitHooks.set(state, hooks);
	}

	public onError(hook: ErrorLifecycleHook): void {
		this.errorHooks.push(hook);
	}

	public setState(next: AgentState): void {
		if (!this.canTransition(next)) {
			throw new Error(`Invalid lifecycle transition ${this.state} -> ${next}`);
		}
		this.state = next;
	}

	public async transition<T>(
		next: AgentState,
		action?: () => Promise<T> | T,
	): Promise<T | void> {
		if (this.transitioning) {
			throw new Error('Lifecycle transition already in progress');
		}

		const previous = this.state;

		if (!this.canTransition(next)) {
			throw new Error(`Invalid lifecycle transition ${this.state} -> ${next}`);
		}

		this.transitioning = true;

		try {
			this.logger?.debugSync(`Lifecycle ${previous} -> ${next}`, {
				component: LogComponents.agent,
				operation: 'lifecycle-transition-start',
				from: previous,
				to: next,
			});

			await this.runHooks(this.exitHooks.get(previous));

			const result = action ? await action() : undefined;

			this.state = next;
			await this.runHooks(this.enterHooks.get(next));

			this.logger?.debugSync(`Lifecycle ${previous} -> ${next} committed`, {
				component: LogComponents.agent,
				operation: 'lifecycle-transition-committed',
				from: previous,
				to: next,
			});

			return result;
		} catch (error) {
			await this.moveToError(error);
			throw error;
		} finally {
			this.transitioning = false;
		}
	}

	public async moveToError(error?: unknown): Promise<void> {
		if (this.state === AgentState.ERROR) {
			return;
		}

		await this.runErrorHooks({
			state: this.state,
			error,
		});

		this.logger?.debugSync(`Lifecycle ${this.state} -> ERROR`, {
			component: LogComponents.agent,
			operation: 'lifecycle-transition-error',
			from: this.state,
			to: AgentState.ERROR,
			error: error instanceof Error ? error.message : String(error),
		});

		this.state = AgentState.ERROR;
	}

	private async runHooks(hooks?: LifecycleHook[]): Promise<void> {
		if (!hooks || hooks.length === 0) {
			return;
		}

		for (const hook of hooks) {
			try {
				await hook();
			} catch (error) {
				this.logHookFailure('Lifecycle hook failed', error);
			}
		}
	}

	private async runErrorHooks(context: { state: AgentState; error: unknown }): Promise<void> {
		for (const hook of this.errorHooks) {
			try {
				await hook(context);
			} catch (error) {
				this.logHookFailure('Lifecycle error hook failed', error);
			}
		}
	}

	private logHookFailure(message: string, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));

		if (this.logger) {
			this.logger.errorSync(message, normalizedError, {
				component: LogComponents.agent,
				operation: 'lifecycle-hook',
			});
			return;
		}

		console.error(message, normalizedError);
	}
}

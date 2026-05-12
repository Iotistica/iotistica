/**
 * Lightweight concurrency limiter.
 * Replaces the `p-limit` package with a minimal native queue.
 */
export function pLimit(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: Array<() => void> = [];

	const next = () => {
		if (queue.length && active < limit) {
			active++;
			queue.shift()!();
		}
	};

	return <T>(fn: () => Promise<T>) =>
		new Promise<T>((res, rej) => {
			queue.push(() => {
				fn()
					.then(res, rej)
					.finally(() => {
						active--;
						next();
					});
			});
			next();
		});
}

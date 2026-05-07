/**
 * Lightweight deep equality check for plain config objects.
 * Replaces lodash isEqual without the dependency overhead.
 * Handles: primitives, null/undefined, arrays, plain objects.
 * Does not handle: Date, RegExp, Map, Set, circular references.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== typeof b) return false;
	if (typeof a !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;

	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b as object);
	if (aKeys.length !== bKeys.length) return false;

	return aKeys.every((k) =>
		deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

import { deepEqual } from './deep-equal';

export function cloneDeep<T>(value: T): T {
	if (typeof structuredClone === 'function') {
		return structuredClone(value);
	}

	return JSON.parse(JSON.stringify(value)) as T;
}

export function castArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value];
}

export function uniq<T>(values: Iterable<T>): T[] {
	return [...new Set(values)];
}

export function difference<T>(...lists: T[][]): T[] {
	const [source = [], ...others] = lists;
	const excluded = new Set(others.flat());
	return source.filter((item) => !excluded.has(item));
}

export function unionBy<T>(key: keyof T, ...lists: T[][]): T[] {
	const seen = new Set<unknown>();
	const merged: T[] = [];

	for (const list of lists) {
		for (const item of list) {
			const itemKey = item[key];
			if (seen.has(itemKey)) {
				continue;
			}

			seen.add(itemKey);
			merged.push(item);
		}
	}

	return merged;
}

export function mapValues<T, R>(
	input: Record<string, T>,
	mapper: (value: T, key: string) => R,
): Record<string, R> {
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, mapper(value, key)]),
	) as Record<string, R>;
}

export function omitKeys<T extends Record<string, unknown>>(
	input: T,
	keys: string[],
): Partial<T> {
	const excluded = new Set(keys);
	return Object.fromEntries(
		Object.entries(input).filter(([key]) => !excluded.has(key)),
	) as Partial<T>;
}

export function mergeObjects<T extends Record<string, unknown>>(
	...inputs: Array<Partial<T> | undefined>
): T {
	return Object.assign({}, ...inputs.filter(Boolean)) as T;
}

export function getPath<T>(
	input: unknown,
	path: string,
	defaultValue: T,
): T {
	const result = path.split('.').reduce<unknown>((current, segment) => {
		if (current == null || typeof current !== 'object') {
			return undefined;
		}

		return (current as Record<string, unknown>)[segment];
	}, input);

	return (result === undefined ? defaultValue : result) as T;
}

export function some<T>(
	values: readonly T[] | undefined,
	predicate: (value: T) => boolean,
): boolean {
	return (values ?? []).some(predicate);
}

export function omitBy<T>(
	input: Record<string, T>,
	predicate: (value: T, key: string) => boolean,
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(input).filter(([key, value]) => !predicate(value, key)),
	) as Record<string, T>;
}

export function isEmpty(value: unknown): boolean {
	if (value == null) {
		return true;
	}

	if (typeof value === 'string' || Array.isArray(value)) {
		return value.length === 0;
	}

	if (typeof value === 'object') {
		return Object.keys(value).length === 0;
	}

	return false;
}

export function isObject(value: unknown): value is object {
	return value !== null && typeof value === 'object';
}

export { deepEqual };
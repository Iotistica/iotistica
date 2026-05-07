/**
 * Compose Utilities
 */
import { mapValues } from '../lib/collection-utils';

export function normalizeLabels(labels: Record<string, any>): Record<string, string> {
	return mapValues(labels, (value) => String(value));
}

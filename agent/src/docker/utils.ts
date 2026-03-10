/**
 * Compose Utilities
 */
import _ from 'lodash';

export function normalizeLabels(labels: Record<string, any>): Record<string, string> {
  return _.mapValues(labels, (value) => String(value));
}

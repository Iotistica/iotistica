'use strict';

/**
 * @iotistic/types — runtime exports.
 *
 * Only constants are exported here; all interfaces are TypeScript-only
 * and live in index.d.ts.
 */

const PIPELINE_ALLOWED_NODE_TYPES = /** @type {const} */ ([
  // Iotistica boundary nodes
  'iotistica-pipeline-in',
  'iotistica-pipeline-out',
  'iotistica-device-filter',
  // NR core — logic / transform
  'function',
  'switch',
  'change',
  'template',
  'split',
  'join',
  'sort',
  'batch',
  'delay',
  'filter',
  'range',
  'json',
  'csv',
  'xml',
  'yaml',
  'html',
  'rbe',
  'debug',
  // NR editor metadata (safe, ignored at runtime)
  'tab',
  'group',
  'global-config',
  'comment',
]);

module.exports = { PIPELINE_ALLOWED_NODE_TYPES };

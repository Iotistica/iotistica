/**
 * MQTT Message Field Schema Dictionary
 * 
 * Single source of truth for compact ↔ expanded field mappings.
 * Shared between edge devices and cloud API for deterministic key compression.
 * 
 * Design principles:
 * - Version all schemas (FIELD_MAP_V1, V2, etc.)
 * - Never remove fields (only add or deprecate)
 * - Use short, intuitive abbreviations
 * - Document all field meanings
 * 
 * Bandwidth savings:
 * - "temperature" (11 bytes) → "t" (1 byte) = 10 bytes/field
 * - Multiply by 1000s of messages = massive reduction
 */

// ============================================================================
// SCHEMA VERSION 1 - Initial Release
// ============================================================================

/**
 * Field mapping: Expanded → Compact
 * Used on edge devices before MessagePack encoding
 */
export const FIELD_MAP_V1 = {
  // Schema metadata
  schema: 's',
  timestamp: 'ts',
  deviceUuid: 'du',
  msgId: 'mi',
  
  // Common sensor fields
  temperature: 't',
  pressure: 'p',
  humidity: 'h',
  rpm: 'r',
  voltage: 'v',
  current: 'i',
  power: 'w',
  frequency: 'f',
  
  // Modbus-specific
  slaveId: 'sid',
  functionCode: 'fc',
  registerAddress: 'ra',
  registerValue: 'rv',
  coilStatus: 'cs',
  
  // OPC UA-specific
  nodeId: 'nid',
  displayName: 'dn',
  browseName: 'bn',
  dataType: 'dt',
  statusCode: 'sc',
  
  // System metrics
  cpuTemp: 'ct',
  cpuPercent: 'cp',
  memoryPercent: 'mp',
  diskUsage: 'du',
  uptime: 'up',
  
  // Sensor publish fields
  sensor: 'sen',
  endpoint: 'ep',
  messages: 'msg',
  value: 'val',
  unit: 'u',
  quality: 'q',
  
  // Anomaly detection
  anomalyScore: 'as',
  anomalyThreshold: 'at',
  isAnomaly: 'ia',
  anomalyReason: 'ar',
} as const;

/**
 * Reverse mapping: Compact → Expanded
 * Used in cloud API after MessagePack decoding
 */
export const REVERSE_FIELD_MAP_V1: Record<string, string> = {
  // Auto-generated from FIELD_MAP_V1
  s: 'schema',
  ts: 'timestamp',
  du: 'deviceUuid',
  mi: 'msgId',
  
  t: 'temperature',
  p: 'pressure',
  h: 'humidity',
  r: 'rpm',
  v: 'voltage',
  i: 'current',
  w: 'power',
  f: 'frequency',
  
  sid: 'slaveId',
  fc: 'functionCode',
  ra: 'registerAddress',
  rv: 'registerValue',
  cs: 'coilStatus',
  
  nid: 'nodeId',
  dn: 'displayName',
  bn: 'browseName',
  dt: 'dataType',
  sc: 'statusCode',
  
  ct: 'cpuTemp',
  cp: 'cpuPercent',
  mp: 'memoryPercent',
  dsk: 'diskUsage',
  up: 'uptime',
  
  sen: 'sensor',
  ep: 'endpoint',
  msg: 'messages',
  val: 'value',
  u: 'unit',
  q: 'quality',
  
  as: 'anomalyScore',
  at: 'anomalyThreshold',
  ia: 'isAnomaly',
  ar: 'anomalyReason',
};

// ============================================================================
// SCHEMA METADATA
// ============================================================================

export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_VERSIONS = {
  1: {
    version: 1,
    fieldMap: FIELD_MAP_V1,
    reverseMap: REVERSE_FIELD_MAP_V1,
    createdAt: '2025-01-15',
    description: 'Initial schema - Modbus, OPC UA, sensor publish, anomaly detection',
  },
} as const;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type ExpandedFieldKey = keyof typeof FIELD_MAP_V1;
export type CompactFieldKey = typeof FIELD_MAP_V1[ExpandedFieldKey];
export type SchemaVersion = keyof typeof SCHEMA_VERSIONS;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compact object keys using schema dictionary
 * Adds schema version field automatically
 * 
 * @param data - Object with expanded keys
 * @param schemaVersion - Schema version to use (default: current)
 * @returns Object with compact keys + schema version
 */
export function compactKeys(
  data: Record<string, any>,
  schemaVersion: SchemaVersion = CURRENT_SCHEMA_VERSION
): Record<string, any> {
  const schema = SCHEMA_VERSIONS[schemaVersion];
  if (!schema) {
    throw new Error(`Unknown schema version: ${schemaVersion}`);
  }
  
  const fieldMap = schema.fieldMap;
  const out: Record<string, any> = {};
  
  // Add schema version (critical for cloud expansion)
  out[fieldMap.schema] = schemaVersion;
  
  // Compact all keys
  for (const [key, value] of Object.entries(data)) {
    const compactKey = fieldMap[key as ExpandedFieldKey] ?? key;
    
    // Recursively compact nested objects
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      out[compactKey] = compactKeys(value, schemaVersion);
    } 
    // Recursively compact arrays of objects
    else if (Array.isArray(value)) {
      out[compactKey] = value.map(item => 
        item && typeof item === 'object' && !(item instanceof Date)
          ? compactKeys(item, schemaVersion)
          : item
      );
    }
    // Primitive values
    else {
      out[compactKey] = value;
    }
  }
  
  return out;
}

/**
 * Expand object keys using schema dictionary
 * Reads schema version from payload
 * 
 * @param data - Object with compact keys (must include schema field)
 * @returns Object with expanded keys
 */
export function expandKeys(data: Record<string, any>): Record<string, any> {
  // Extract schema version (default to V1 if missing for backward compat)
  const compactSchemaKey = FIELD_MAP_V1.schema;
  const schemaVersion = (data[compactSchemaKey] ?? 1) as SchemaVersion;
  
  const schema = SCHEMA_VERSIONS[schemaVersion];
  if (!schema) {
    throw new Error(`Unknown schema version in payload: ${schemaVersion}`);
  }
  
  const reverseMap = schema.reverseMap;
  const out: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(data)) {
    const expandedKey = reverseMap[key] ?? key;
    
    // Recursively expand nested objects
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      out[expandedKey] = expandKeys(value);
    }
    // Recursively expand arrays of objects
    else if (Array.isArray(value)) {
      out[expandedKey] = value.map(item =>
        item && typeof item === 'object' && !(item instanceof Date)
          ? expandKeys(item)
          : item
      );
    }
    // Primitive values
    else {
      out[expandedKey] = value;
    }
  }
  
  return out;
}

/**
 * Get schema for a specific version
 */
export function getSchema(version: SchemaVersion = CURRENT_SCHEMA_VERSION) {
  return SCHEMA_VERSIONS[version];
}

/**
 * Check if a key exists in the schema
 */
export function hasFieldMapping(key: string, schemaVersion: SchemaVersion = CURRENT_SCHEMA_VERSION): boolean {
  const schema = SCHEMA_VERSIONS[schemaVersion];
  return key in schema.fieldMap;
}

/**
 * MQTT Payload Parser Utilities
 * 
 * Pure functions for parsing and type-coercing MQTT payloads.
 * Extracted from adapter for better testability and reusability.
 * 
 * @module mqtt/payload-parser
 */

/**
 * Parse MQTT payload based on dataType
 * 
 * Strategy:
 * 1. Try JSON parse first
 * 2. If JSON object with 'value' key, extract it
 * 3. Otherwise, parse as plain text
 * 
 * @param payload - Raw MQTT message buffer
 * @param dataType - Expected data type (number, boolean, string, json, etc.)
 * @returns Parsed and coerced value
 * @throws Error if parsing or coercion fails
 */
export function parsePayload(payload: Buffer, dataType: string): number | boolean | string {
  const str = payload.toString();

  // Try JSON first
  try {
    const json = JSON.parse(str);
    
    // If JSON object with 'value' key, extract it
    if (typeof json === 'object' && json.value !== undefined) {
      return coerceType(json.value, dataType);
    }
    
    return coerceType(json, dataType);
  } catch {
    // Not JSON, parse as plain text
    return coerceType(str, dataType);
  }
}

/**
 * Coerce value to expected dataType
 * 
 * Supports both:
 * - Broad types from discovery: 'number', 'boolean', 'string', 'json'
 * - Specific types from manual config: 'int32', 'float32', 'uint32'
 * 
 * Production-safe: Detects NaN and throws error rather than silently returning invalid data
 * 
 * @param value - Value to coerce (any type)
 * @param dataType - Target data type
 * @returns Coerced value
 * @throws Error if coercion results in NaN for numeric types
 */
export function coerceType(value: any, dataType: string): number | boolean | string {
  switch (dataType) {
    case 'number':  // Broad category from discovery
    case 'float':
    case 'float32':
    case 'double': {
      const n = parseFloat(value);
      // Production fix: Detect NaN and throw error
      if (Number.isNaN(n)) {
        throw new Error(`Numeric coercion resulted in NaN for value: "${value}"`);
      }
      return n;
    }
    case 'int':
    case 'int16':
    case 'int32':
    case 'integer': {
      const n = parseInt(value, 10);
      // Production fix: Detect NaN and throw error
      if (Number.isNaN(n)) {
        throw new Error(`Numeric coercion resulted in NaN for value: "${value}"`);
      }
      return n;
    }
    case 'uint16':
    case 'uint32': {
      const n = Math.abs(parseInt(value, 10));
      // Production fix: Detect NaN and throw error
      if (Number.isNaN(n)) {
        throw new Error(`Numeric coercion resulted in NaN for value: "${value}"`);
      }
      return n;
    }
    case 'boolean':
      return value === 'true' || value === '1' || value === 1 || value === true;
    case 'json':    // Broad category from discovery
      // For JSON dataType with object value, stringify it; otherwise convert to string
      return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    case 'string':
      return String(value);
    default:
      return value;
  }
}

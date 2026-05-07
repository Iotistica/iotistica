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
 * 2. If valid JSON, return parsed object/primitive
 * 3. Otherwise, return plain text
 *
 * @param payload - Raw MQTT message buffer
 * @returns Parsed raw value (object, array, primitive, or string)
 */
export function parsePayload(payload: Buffer): unknown {
	const str = payload.toString();

	// Try JSON first
	try {
		return JSON.parse(str);
	} catch {
		// Not JSON, return as plain text
		return str;
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
export function coerceType(
	value: any,
	dataType: string,
): number | boolean | string {
	const valueForError =
		typeof value === "object" && value !== null
			? JSON.stringify(value)
			: String(value);

	switch (dataType) {
		case "number": // Broad category from discovery
		case "float":
		case "float32":
		case "double": {
			const n = parseFloat(value);
			// Production fix: Detect NaN and throw error
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "int":
		case "int16":
		case "int32":
		case "integer": {
			const n = parseInt(value, 10);
			// Production fix: Detect NaN and throw error
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "uint16":
		case "uint32": {
			const n = Math.abs(parseInt(value, 10));
			// Production fix: Detect NaN and throw error
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "boolean":
			return value === "true" || value === "1" || value === 1 || value === true;
		case "json": // Broad category from discovery
			// For JSON dataType with object value, stringify it; otherwise convert to string
			return typeof value === "object" && value !== null
				? JSON.stringify(value)
				: String(value);
		case "string":
			return String(value);
		default:
			return String(value);
	}
}

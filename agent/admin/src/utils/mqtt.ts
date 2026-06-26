const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ID_REGEX = /^[0-9a-f]{12}$/i

function b64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeIfUuid(value: string): string {
  if (UUID_REGEX.test(value)) return b64url(value.replace(/-/g, ''))
  if (HEX_ID_REGEX.test(value)) return b64url(value)
  return value
}

/** Build the Iotistica MQTT topic prefix for this agent: i/{tenant}/a/{agent}/endpoints */
export function buildIotisticaTopicBase(agentUuid: string, tenantId: string): string {
  return `i/${encodeIfUuid(tenantId)}/a/${encodeIfUuid(agentUuid)}/endpoints`
}

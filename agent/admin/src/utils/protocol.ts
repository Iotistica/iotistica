export const PROTOCOL_COLORS: Record<string, string> = {
  modbus: 'blue',
  opcua: 'purple',
  mqtt: 'green',
  bacnet: 'orange',
  system: 'geekblue',
}

export function protocolColor(protocol: string): string {
  return PROTOCOL_COLORS[protocol?.toLowerCase()] ?? 'default'
}

export const PROTOCOL_LABELS: Record<string, string> = {
  modbus: 'Modbus',
  opcua: 'OPC-UA',
  mqtt: 'MQTT',
  bacnet: 'BACnet',
}

export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol?.toLowerCase()] ?? protocol
}

export const METHOD_COLORS: Record<string, string> = {
  zscore:         'blue',
  mad:            'purple',
  iqr:            'geekblue',
  expected_range: 'volcano',
  rate_change:    'gold',
  ewma:           'cyan',
  fusion:         'magenta',
}

export function methodColor(method: string): string {
  return METHOD_COLORS[method?.toLowerCase()] ?? 'default'
}

export const DESTINATION_COLORS: Record<string, string> = {
  mqtt: 'green',
  azure: 'blue',
  aws: 'orange',
  gcp: 'cyan',
}

export function destinationColor(type: string): string {
  return DESTINATION_COLORS[type?.toLowerCase()] ?? 'default'
}

/**
 * System configuration bootstrap: loads MQTT, VPN, and other settings.
 */

import logger from '../utils/logger';

export async function bootstrapConfig(): Promise<void> {
  const { SystemConfig } = await import('../config/system-config');
  await SystemConfig.load();
  logger.info('System configuration loaded successfully');
}

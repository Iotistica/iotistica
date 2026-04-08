/**
 * System configuration bootstrap: loads MQTT, VPN, and other settings.
 */

import logger from '../utils/logger';
import { SystemConfig } from '../services/system-config.service';

export async function bootstrapConfig(): Promise<void> {
  await SystemConfig.load();
  logger.info('System configuration loaded successfully');
}

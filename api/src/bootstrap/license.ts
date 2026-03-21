/**
 * License validator bootstrap. Mandatory - the service cannot run without a valid license.
 */

import logger from '../utils/logger';
import { LicenseValidator } from '../services/license-validator';

export async function bootstrapLicense(): Promise<void> {
  logger.info('Initializing license validator...');
  const licenseValidator = LicenseValidator.getInstance();
  await licenseValidator.init();
}

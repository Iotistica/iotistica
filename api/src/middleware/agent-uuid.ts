import type { FastifyRequest, FastifyReply } from 'fastify';
import { AgentModel } from '../db/models';
import logger from '../utils/logger';

export async function checkUuidImmutability(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const { uuid } = request.body as any;
    if (!uuid) return;

    const existingDevice = await AgentModel.getByUuid(uuid);
    if (existingDevice && existingDevice.provisioning_state === 'registered') {
      logger.warn(`Re-provisioning attempt for registered device: ${uuid.substring(0, 8)}...`);
      return reply.status(409).send({
        error: 'Device already registered',
        message: 'Device already registered with this UUID. Factory reset to re-provision.',
        details: {
          uuid,
          provisioning_state: existingDevice.provisioning_state,
          provisioned_at: existingDevice.provisioned_at
        }
      });
    }
  } catch (error: any) {
    logger.error('Error checking UUID immutability:', error);
    // Soft fail - let service layer handle it
  }
}

export async function optionalUuidImmutabilityCheck(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  try {
    const { uuid } = request.body as any;
    if (!uuid) return;

    const existingDevice = await AgentModel.getByUuid(uuid);
    if (existingDevice?.provisioning_state === 'registered') {
      // Soft fail - log only, do not block (optional variant)
      logger.debug('Optional UUID check: device already registered', { uuid: uuid.substring(0, 8) });
    }
  } catch {
    // Soft fail
  }
}

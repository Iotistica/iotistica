/**
 * Agent Authentication Routes — Phase 2 of two-phase authentication (PoP)
 *
 * - POST /api/v1/device/:uuid/challenge     Issue a PoP challenge (Phase 2a)
 * - POST /api/v1/device/:uuid/key-exchange  Verify PoP signature  (Phase 2b)
 */
import crypto from 'crypto';
import { AgentModel } from '../../services/agent/agents';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import logger from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify';
import type { DeviceUuidParams, KeyExchangeBody } from './types';

const plugin: FastifyPluginAsync = async (fastify) => {

  /**
   * Issue a PoP challenge to an agent
   * POST /api/v1/device/:uuid/challenge
   *
   * Generates a cryptographically secure nonce, stores it with a 5-minute TTL,
   * and returns it so the agent can sign it to prove private-key ownership.
   */
  fastify.post<{ Params: DeviceUuidParams }>('/device/:uuid/challenge', async (req, reply) => {
    const { uuid } = req.params;
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];

    try {
      const agent = await AgentModel.getByUuid(uuid);

      if (!agent) {
        await logAuditEvent({
          eventType: AuditEventType.AUTHENTICATION_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Agent not found', endpoint: 'challenge' },
        });
        return reply.status(404).send({
          error: 'Agent not found',
          message: `Agent ${uuid} not registered`,
        });
      }

      // Reject if an active challenge already exists to prevent race-condition overwrites.
      if (agent.last_challenge && agent.last_challenge_expires_at && new Date(agent.last_challenge_expires_at) > new Date()) {
        return reply.status(409).send({
          error: 'Challenge already issued',
          message: 'An active challenge already exists for this agent. Wait for it to expire or complete key exchange first.',
          expiresAt: new Date(agent.last_challenge_expires_at).toISOString(),
        });
      }

      const challenge = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      logger.info('Generating new PoP challenge', {
        agentUuid: uuid.substring(0, 8) + '...',
        agentName: agent.name,
        challengeLength: challenge.length,
        expiresAt: expiresAt.toISOString(),
        hasPublicKey: !!agent.device_public_key,
        currentlyVerified: agent.pop_verified,
      });

      await AgentModel.storeChallenge(uuid, challenge, expiresAt);

      logger.info('PoP challenge stored and issued to agent', {
        agentUuid: uuid.substring(0, 8) + '...',
        agentName: agent.name,
        expiresAt: expiresAt.toISOString(),
      });

      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.INFO,
        details: { action: 'challenge_issued', expiresAt: expiresAt.toISOString() },
      });

      return reply.send({ challenge, expiresAt: expiresAt.toISOString() });
    } catch (error: unknown) {
      logger.error('Error issuing PoP challenge:', error);

      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.ERROR,
        details: { error: error instanceof Error ? error.message : 'Unknown error', endpoint: 'challenge' },
      });

      return reply.status(500).send({
        error: 'Challenge issuance failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Verify PoP signature and complete key exchange
   * POST /api/v1/device/:uuid/key-exchange
   *
   * Verifies the agent's signature over uuid:challenge using its registered
   * public key (Ed25519 or ECDSA P-256 only). Single-use: challenge is
   * invalidated immediately on success.
   */
  fastify.post<{ Params: DeviceUuidParams; Body: KeyExchangeBody }>('/device/:uuid/key-exchange', async (req, reply) => {
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];

    try {
      const { uuid } = req.params;
      const { signature } = req.body;
      const authKey = (req.headers['x-device-key'] as string) ?? undefined;

      if (!authKey) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Missing x-device-key header' },
        });
        return reply.status(400).send({ error: 'Missing credentials', message: 'x-device-key header required' });
      }

      if (!signature) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Missing signature for proof-of-possession verification' },
        });
        return reply.status(400).send({
          error: 'Missing credentials',
          message: 'signature required in body for proof-of-possession authentication',
        });
      }

      logger.info('Key exchange request received', {
        agentUuid: uuid.substring(0, 8) + '...',
        hasSignature: !!signature,
      });

      const agent = await AgentModel.getByUuid(uuid);

      if (!agent) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Agent not found' },
        });
        return reply.status(404).send({
          error: 'Agent not found',
          message: `Agent ${uuid} not registered`,
        });
      }

      // ======================================================================
      // PROOF OF POSSESSION: Verify signature against stored challenge
      // ======================================================================
      if (agent.device_public_key && signature) {
        logger.info('Attempting PoP verification with signature', {
          agentUuid: uuid.substring(0, 8) + '...',
          hasPublicKey: true,
          signatureLength: signature.length,
          hasChallenge: !!agent.last_challenge,
          challengeExpiry: agent.last_challenge_expires_at?.toISOString(),
        });

        if (!agent.last_challenge || !agent.last_challenge_expires_at) {
          await logAuditEvent({
            eventType: AuditEventType.KEY_EXCHANGE_FAILED,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: 'No challenge found - call /challenge first' },
          });
          return reply.status(401).send({
            error: 'No challenge found',
            message: 'Request a challenge from /device/:uuid/challenge first',
          });
        }

        if (agent.last_challenge_expires_at < new Date()) {
          await logAuditEvent({
            eventType: AuditEventType.KEY_EXCHANGE_FAILED,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: 'Challenge expired' },
          });
          return reply.status(401).send({
            error: 'Challenge expired',
            message: 'Challenge has expired - request a new one',
          });
        }

        try {
          logger.info('Verifying PoP signature', {
            agentUuid: uuid.substring(0, 8) + '...',
            challengeLength: agent.last_challenge.length,
            signatureLength: signature.length,
            publicKeyLength: agent.device_public_key.length,
          });

          // HARDENING: Enforce public key algorithm allowlist (Ed25519 or ECDSA P-256 only)
          const publicKeyObject = crypto.createPublicKey({ key: agent.device_public_key, format: 'pem' });
          const allowedAlgorithms = ['ed25519', 'ec'];
          const keyType = publicKeyObject.asymmetricKeyType;

          if (!allowedAlgorithms.includes(keyType)) {
            logger.warn('Rejecting disallowed public key algorithm', {
              agentUuid: uuid.substring(0, 8) + '...',
              algorithm: keyType,
              allowed: allowedAlgorithms,
            });
            await logAuditEvent({
              eventType: AuditEventType.AUTHENTICATION_FAILED,
              agentUuid: uuid,
              ipAddress,
              userAgent,
              severity: AuditSeverity.WARNING,
              details: { reason: `Disallowed key algorithm: ${keyType}. Only Ed25519 and ECDSA P-256 allowed.` },
            });
            return reply.status(401).send({
              error: 'Invalid key algorithm',
              message: 'Device public key must use Ed25519 or ECDSA P-256',
            });
          }

          if (keyType === 'ec') {
            const keyDetails = publicKeyObject.asymmetricKeyDetails;
            if (keyDetails?.namedCurve !== 'prime256v1' && keyDetails?.namedCurve !== 'P-256') {
              logger.warn('Rejecting ECDSA key with non-P-256 curve', {
                agentUuid: uuid.substring(0, 8) + '...',
                curve: keyDetails?.namedCurve,
              });
              await logAuditEvent({
                eventType: AuditEventType.AUTHENTICATION_FAILED,
                agentUuid: uuid,
                ipAddress,
                userAgent,
                severity: AuditSeverity.WARNING,
                details: { reason: `ECDSA key must use P-256 curve, got ${keyDetails?.namedCurve}` },
              });
              return reply.status(401).send({
                error: 'Invalid key curve',
                message: 'ECDSA key must use P-256 curve',
              });
            }
          }

          // Bind agent UUID to signature payload to prevent cross-agent replay.
          // Client signs: uuid:challenge — server verifies the same construction.
          const payload = `${uuid}:${agent.last_challenge}`;
          const isValid = crypto.verify(
            null, // Algorithm detected from key
            Buffer.from(payload, 'utf-8'),
            agent.device_public_key,
            Buffer.from(signature, 'base64'),
          );

          logger.info('Signature verification result', {
            agentUuid: uuid.substring(0, 8) + '...',
            isValid,
            payloadLength: payload.length,
          });

          if (!isValid) {
            await logAuditEvent({
              eventType: AuditEventType.AUTHENTICATION_FAILED,
              agentUuid: uuid,
              ipAddress,
              userAgent,
              severity: AuditSeverity.WARNING,
              details: { reason: 'Invalid signature - proof of possession failed' },
            });
            return reply.status(401).send({
              error: 'Proof of possession failed',
              message: 'Invalid signature',
            });
          }

          // PoP verified — invalidate challenge immediately (single-use)
          logger.info('Invalidating challenge after successful PoP verification', {
            agentUuid: uuid.substring(0, 8) + '...',
            reason: 'single-use challenge enforcement',
          });
          await AgentModel.storeChallenge(uuid, null, new Date());

          await AgentModel.markPopVerified(uuid);
          await AgentModel.recordAuthMethod(uuid, 'pop');

          logger.info('PoP verification successful and persisted', {
            agentUuid: uuid.substring(0, 8) + '...',
            agentName: agent.name,
            authMethod: 'proof-of-possession',
          });

          await logAuditEvent({
            eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.INFO,
            details: { agentName: agent.name, authMethod: 'proof-of-possession' },
          });

          return reply.send({
            status: 'ok',
            message: 'Proof of possession verified',
            device: { id: agent.id, uuid: agent.uuid, deviceName: agent.name },
          });
        } catch (verifyError: unknown) {
          logger.error('Signature verification error:', verifyError);

          await logAuditEvent({
            eventType: AuditEventType.KEY_EXCHANGE_FAILED,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.ERROR,
            details: {
              reason: 'Signature verification failed',
              error: verifyError instanceof Error ? verifyError.message : 'Unknown error',
            },
          });

          return reply.status(401).send({
            error: 'Signature verification failed',
            message: 'Invalid signature format or corrupted public key',
          });
        }
      }

      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: {
          reason: !agent.device_public_key
            ? 'Device has no registered public key'
            : 'Proof-of-possession verification did not complete',
        },
      });

      return reply.status(401).send({
        error: 'Proof of possession required',
        message: 'Device must register a public key and provide a valid signature for key exchange',
      });
    } catch (error: unknown) {
      logger.error('Error during key exchange:', error);

      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: req.params.uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.ERROR,
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      });

      return reply.status(500).send({
        error: 'Key exchange failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

};

export default plugin;

/**
 * Provisioning root plugin
 * Composes key management, agent registration, and agent authentication sub-plugins.
 */
import type { FastifyPluginAsync } from 'fastify';
import keysPlugin from './keys';
import agentRegisterPlugin from './agent-register';
import agentAuthPlugin from './agent-auth';

const plugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(keysPlugin);
  await fastify.register(agentRegisterPlugin);
  await fastify.register(agentAuthPlugin);
};

export default plugin;

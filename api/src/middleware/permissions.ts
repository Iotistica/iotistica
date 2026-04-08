/**
 * Permission Middleware
 * 
 * Provides Fastify preHandlers for checking user permissions and roles.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { Permission, Role, ROLE_PERMISSIONS, ROLES } from '../types/permissions';

/**
 * Middleware to check if user has ALL required permissions (AND logic)
 * 
 * @param requiredPermissions - Array of permissions that user must have
 * @returns Fastify preHandler
 * 
 * @example
 * router.post('/users', hasPermission(PERMISSIONS.USER_WRITE), createUser);
 */
export function hasPermission(...requiredPermissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    if (!request.user.isActive) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Account is disabled' });
    }
    const userPermissions = ROLE_PERMISSIONS[request.user.role as Role] || [];
    const missingPermissions = requiredPermissions.filter(perm => !userPermissions.includes(perm));
    if (missingPermissions.length > 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: requiredPermissions,
        missing: missingPermissions,
        userRole: request.user.role
      });
    }
  };
}

/**
 * Middleware to check if user has ANY of the required permissions (OR logic)
 * 
 * @param requiredPermissions - Array of permissions (user needs at least one)
 * @returns Fastify preHandler
 * 
 * @example
 * router.get('/data', hasAnyPermission(PERMISSIONS.DATA_READ, PERMISSIONS.DATA_EXPORT), getData);
 */
export function hasAnyPermission(...requiredPermissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    if (!request.user.isActive) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Account is disabled' });
    }
    const userPermissions = ROLE_PERMISSIONS[request.user.role as Role] || [];
    const hasAny = requiredPermissions.some(perm => userPermissions.includes(perm));
    if (!hasAny) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: 'At least one of: ' + requiredPermissions.join(', '),
        userRole: request.user.role
      });
    }
  };
}

/**
 * Middleware to check if user has specific role(s)
 * 
 * @param allowedRoles - Array of allowed roles
 * @returns Fastify preHandler
 * 
 * @example
 * router.get('/billing', hasRole(ROLES.OWNER), getBilling);
 * router.get('/admin', hasRole(ROLES.OWNER, ROLES.ADMIN), getAdminPanel);
 */
export function hasRole(...allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    if (!request.user.isActive) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Account is disabled' });
    }
    if (!allowedRoles.includes(request.user.role as Role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Access restricted to: ${allowedRoles.join(', ')}`,
        userRole: request.user.role
      });
    }
  };
}

/**
 * Middleware to check if user is owner (convenience function)
 * 
 * @returns Fastify preHandler
 * 
 * @example
 * router.post('/billing/subscribe', isOwner(), subscribe);
 */
export function isOwner() {
  return hasRole(ROLES.OWNER);
}

/**
 * Middleware to check if user is admin or owner
 * 
 * @returns Fastify preHandler
 * 
 * @example
 * router.delete('/users/:id', isAdminOrOwner(), deleteUser);
 */
export function isAdminOrOwner() {
  return hasRole(ROLES.OWNER, ROLES.ADMIN);
}

/**
 * Helper function to check permissions programmatically (not middleware)
 * Useful for conditional logic inside route handlers
 * 
 * @param user - User object
 * @param permissions - Permissions to check
 * @returns boolean
 * 
 * @example
 * if (checkUserPermissions(req.user, PERMISSIONS.USER_DELETE)) {
 *   // User can delete
 * }
 */
export function checkUserPermissions(
  user: FastifyRequest['user'],
  ...permissions: Permission[]
): boolean {
  if (!user || !user.isActive) return false;
  
  const userPermissions = ROLE_PERMISSIONS[user.role as Role] || [];
  return permissions.every(perm => userPermissions.includes(perm));
}

import type { FastifyRequest } from 'fastify';
import type { ClientMeta } from '../application/auth.service';

/**
 * IP and user agent for a session record. `req.ip` honours TRUST_PROXY, so a
 * client cannot write its own address into the audit trail (#129).
 */
export function clientMeta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return {
    ...(req.ip ? { ip: req.ip } : {}),
    ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 256) } : {}),
  };
}

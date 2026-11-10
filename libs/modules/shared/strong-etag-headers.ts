import type { FastifyReply } from 'fastify';

/** Preserve strong validators through intermediaries that compress/transform responses. */
export function setStrongEtagHeaders(
  reply: FastifyReply,
  etag: string,
  cacheControl = 'private, no-store',
): void {
  void reply.header('ETag', etag).header('Cache-Control', `${cacheControl}, no-transform`);
}

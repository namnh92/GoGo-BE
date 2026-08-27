import { createLogger } from '@gogo/observability';

/**
 * Worker process — BullMQ consumers for suggestion, import, reindex,
 * notification, privacy and AI refinement. Queue consumers register here as
 * their modules land (BE-BFF-010, SG-*, DB-010, BE-BFF-013).
 */
async function bootstrap(): Promise<void> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'gogo-worker',
    pretty: process.env.NODE_ENV === 'development',
  });
  logger.info('worker booted — no consumers registered yet');

  const shutdown = () => {
    logger.info('worker shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

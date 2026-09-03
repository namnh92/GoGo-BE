import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';

/**
 * COST-BE-028 (#387) — the Cost Center's only consumer-facing surface.
 *
 * Everything else in `libs/modules/cost` is read by the CMS (`CmsModule`) or
 * by the worker's scheduler; this module exists because client-reported usage
 * arrives on the app's own API, not through the back office, and a controller
 * needs a module to live in.
 */
@Module({
  controllers: [TelemetryController],
})
export class CostModule {}

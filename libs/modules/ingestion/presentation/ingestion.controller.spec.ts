import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from '../../shared/idempotency.interceptor';
import { IngestionController } from './ingestion.controller';

describe('resolve preview replay boundary (#786 F-01)', () => {
  it('executes keyed resolves afresh without touching replay storage or retaining photo credits', async () => {
    const body = { url: 'https://www.google.com/maps?place_id=ChIJ-preview' };
    const preview = (name: string) => ({
      candidate: {
        photo: {
          url: '/v1/places/provider-photo-preview?googlePlaceId=ChIJ-preview',
          authorAttributions: [{ displayName: name, uri: null, photoUri: null }],
        },
      },
    });
    const submissions = {
      resolveLink: vi
        .fn()
        .mockResolvedValueOnce(preview('Lan'))
        .mockResolvedValueOnce(preview('Mai')),
    };
    const controller = new IngestionController(submissions as never);
    const db = {
      insert: vi.fn(() => {
        throw new Error('Preview attempted replay persistence');
      }),
      select: vi.fn(() => {
        throw new Error('Preview attempted replay lookup');
      }),
    };
    const request = {
      method: 'POST',
      headers: { 'idempotency-key': 'resolve-preview-786' },
      routeOptions: { url: '/v1/places/resolve-google-maps-link' },
      body,
    };
    const context = {
      getHandler: () => IngestionController.prototype.resolve,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
    const interceptor = new IdempotencyInterceptor(db as never, new Reflector());
    const next = { handle: () => defer(() => controller.resolve(body)) };

    await expect(firstValueFrom(interceptor.intercept(context, next))).resolves.toEqual(
      preview('Lan'),
    );
    await expect(firstValueFrom(interceptor.intercept(context, next))).resolves.toEqual(
      preview('Mai'),
    );
    expect(submissions.resolveLink).toHaveBeenCalledTimes(2);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});

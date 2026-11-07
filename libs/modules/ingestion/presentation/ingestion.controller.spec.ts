import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from '../../shared/idempotency.interceptor';
import { IngestionController } from './ingestion.controller';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { ZodValidationPipe } from '../../shared/zod-validation.pipe';

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

describe('#801 resolution token contract compatibility', () => {
  const contract = parse(readFileSync(path.resolve('openapi/gogo.v1.yaml'), 'utf8'));
  it.each([
    '/cms/place-submissions/{id}/provider-preview',
    '/cms/places/resolve-link',
    '/places/resolve-google-maps-link',
  ])('keeps POST %s response resolutionToken at 1024 characters', (endpoint) => {
    const ref = contract.paths[endpoint].post.responses['201'].content['application/json'].schema
      .$ref as string;
    const schema = ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node[key], contract);
    expect(schema.properties.resolutionToken).toMatchObject({ type: 'string', maxLength: 1024 });
  });

  it('enforces the same unchanged limit in the submit HTTP validation pipe', () => {
    const args = Reflect.getMetadata('__routeArguments__', IngestionController, 'submit') as Record<
      string,
      { pipes: ZodValidationPipe<unknown>[] }
    >;
    const pipe = Object.values(args)
      .flatMap((arg) => arg.pipes)
      .find((pipe) => typeof pipe === 'object' && 'transform' in pipe)!;
    expect(
      pipe.transform({ googlePlaceId: 'resolved-place', resolutionToken: 'a'.repeat(1024) }),
    ).toMatchObject({ resolutionToken: 'a'.repeat(1024) });
    expect(() =>
      pipe.transform({ googlePlaceId: 'resolved-place', resolutionToken: 'a'.repeat(1025) }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(
      contract.paths['/place-submissions'].post.requestBody.content['application/json'].schema
        .properties.resolutionToken.maxLength,
    ).toBe(1024);
  });
});

it.each([{}, { min: 100 }, { max: 200 }, { unit: 'per_item' }])(
  'F-06 accepts contract-valid partial estimatedPrice %j',
  (estimatedPrice) => {
    const args = Reflect.getMetadata('__routeArguments__', IngestionController, 'submit') as Record<
      string,
      { pipes: { transform: (value: unknown) => unknown }[] }
    >;
    const pipe = Object.values(args)
      .flatMap((arg) => arg.pipes)
      .find((p) => typeof p === 'object' && 'transform' in p)!;
    expect(() => pipe.transform({ googlePlaceId: 'valid-place', estimatedPrice })).not.toThrow();
  },
);

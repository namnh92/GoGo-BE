import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { DB } from '../../../libs/modules/shared/tokens';
import { TaxonomyController } from '../../../libs/modules/places/presentation/taxonomy.controller';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

function fixture() {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ version: 7, updatedAt: new Date('2026-11-07Z') }]),
  };
  const list = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
  };
  const select = vi.fn((fields?: unknown) => (fields ? list : query));
  const transaction = vi.fn(async (fn: (db: unknown) => unknown) => fn({ select }));
  const db = { select, transaction } as unknown as Db;
  return { db, select, transaction, query, list };
}

it.each([
  'version read',
  'list query',
  'transaction completion',
  'conditional transaction completion',
])('returns an uncacheable 500 without ETag on %s failure', async (failure) => {
  const f = fixture();
  @Module({ controllers: [TaxonomyController], providers: [{ provide: DB, useValue: f.db }] })
  class Harness {}
  const app = await NestFactory.create<NestFastifyApplication>(Harness, new FastifyAdapter(), {
    logger: false,
  });
  try {
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const url = failure === 'version read' ? '/v1/taxonomies/version' : '/v1/taxonomies';
    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toEqual(expect.any(String));
    const error = new Error('taxonomy database failure');
    if (failure === 'version read') {
      f.query.where.mockRejectedValueOnce(error);
    } else if (failure === 'list query') {
      f.list.orderBy.mockRejectedValueOnce(error);
    } else {
      f.transaction.mockImplementationOnce(async (fn) => {
        await fn({ select: f.select });
        throw error;
      });
    }
    const response = await app.inject({
      method: 'GET',
      url,
      headers:
        failure === 'conditional transaction completion'
          ? { 'if-none-match': String(first.headers.etag) }
          : {},
    });
    expect.soft(response.statusCode).toBe(500);
    expect.soft(response.headers.etag).toBeUndefined();
    expect.soft(response.headers['cache-control']).toBe('no-store');
    if (response.statusCode === 500) {
      expect(response.json()).toMatchObject({ code: 'INTERNAL', retryable: true });
      expect(response.body).not.toContain(error.message);
    }
  } finally {
    await app.close();
  }
});

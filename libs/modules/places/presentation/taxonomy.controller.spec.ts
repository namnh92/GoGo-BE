import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DB } from '../../shared/tokens';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { Db } from '@gogo/database';
import { TaxonomyController } from './taxonomy.controller';

function fixture() {
  let version = 7;
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() => Promise.resolve([{ version, updatedAt: new Date('2026-11-07Z') }])),
  };
  const list = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([
      { id: 'one', kind: 'mood', key: 'chill', sortOrder: 0, locale: 'vi', label: 'Thư giãn' },
      { id: 'one', kind: 'mood', key: 'chill', sortOrder: 0, locale: 'en', label: 'Relax' },
      { id: 'two', kind: 'amenity', key: 'wifi', sortOrder: 0, locale: 'vi', label: 'Wifi' },
    ]),
  };
  const select = vi.fn((fields?: unknown) => (fields ? list : query));
  const tx = { select };
  const transaction = vi.fn(async (fn: (db: unknown) => unknown) => fn(tx));
  const db = { select, transaction } as unknown as Db;
  const controller = new TaxonomyController(db);
  function reply() {
    const headers: Record<string, string> = {};
    const response = {
      header: vi.fn((name: string, value: string) => {
        headers[name] = value;
        return response;
      }),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    return { headers, response, raw: response as unknown as FastifyReply };
  }
  return {
    db,
    controller,
    transaction,
    select,
    list,
    reply,
    bump: () => {
      version++;
    },
  };
}

describe('taxonomy conditional reads', () => {
  it('preserves all labels by default, filters locale/kinds and scopes canonical validators', async () => {
    const f = fixture();
    const all = f.reply();
    expect(await f.controller.list(all.raw)).toMatchObject({
      version: 7,
      kinds: {
        mood: [{ key: 'chill', labels: { vi: 'Thư giãn', en: 'Relax' } }],
      },
    });
    const vi = f.reply();
    const result = await f.controller.list(vi.raw, 'mood,amenity', 'vi');
    expect(result!.kinds.mood![0]!.labels).toEqual({ vi: 'Thư giãn' });
    const canonical = f.reply();
    await f.controller.list(canonical.raw, ' amenity,mood,mood ', 'vi');
    expect(canonical.headers.ETag).toBe(vi.headers.ETag);
    const en = f.reply();
    await f.controller.list(en.raw, 'mood,amenity', 'en', vi.headers.ETag);
    expect(en.headers.ETag).not.toBe(vi.headers.ETag);
    const mood = f.reply();
    const only = await f.controller.list(mood.raw, 'mood', 'vi');
    expect(Object.keys(only!.kinds)).toEqual(['mood']);
    expect(mood.headers.ETag).not.toBe(vi.headers.ETag);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });

  it('returns bodyless 304, retains cache headers and skips taxonomy rows on a hit', async () => {
    const f = fixture();
    const first = f.reply();
    await f.controller.list(first.raw);
    const tag = first.headers.ETag!;
    for (const header of [tag, tag.replace('W/', ''), `"unrelated", ${tag}`, '*']) {
      const response = f.reply();
      f.list.orderBy.mockClear();
      expect(await f.controller.list(response.raw, undefined, undefined, header)).toBeUndefined();
      expect(response.response.status).toHaveBeenCalledWith(304);
      expect(response.response.send).toHaveBeenCalledWith();
      expect(response.headers).toEqual(first.headers);
      expect(f.list.orderBy).not.toHaveBeenCalled();
    }
    expect(first.headers['Cache-Control']).toBe('public, max-age=60, stale-while-revalidate=300');
    f.bump();
    const changed = f.reply();
    expect(await f.controller.list(changed.raw, undefined, undefined, tag)).toMatchObject({
      version: 8,
    });
    expect(changed.response.status).not.toHaveBeenCalled();
    expect(changed.headers.ETag).not.toBe(tag);
  });

  it('checks version with one select and a separate validator scope', async () => {
    const f = fixture();
    const first = f.reply();
    expect(await f.controller.version(first.raw)).toEqual({
      version: 7,
      updatedAt: '2026-11-07T00:00:00.000Z',
    });
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.transaction).not.toHaveBeenCalled();
    expect(first.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    const hit = f.reply();
    expect(await f.controller.version(hit.raw, first.headers.ETag)).toBeUndefined();
    expect(hit.response.status).toHaveBeenCalledWith(304);
    const list = f.reply();
    await f.controller.list(list.raw);
    expect(list.headers.ETag).not.toBe(first.headers.ETag);
  });
});

it('serves conditional GET over Nest/Fastify with an empty 304 payload', async () => {
  const f = fixture();
  @Module({ controllers: [TaxonomyController], providers: [{ provide: DB, useValue: f.db }] })
  class Harness {}
  const app = await NestFactory.create<NestFastifyApplication>(Harness, new FastifyAdapter(), {
    logger: false,
  });
  try {
    app.setGlobalPrefix('v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const first = await app.inject({ method: 'GET', url: '/v1/taxonomies?locale=vi' });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(7);
    const second = await app.inject({
      method: 'GET',
      url: '/v1/taxonomies?locale=vi',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.headers['cache-control']).toBe(first.headers['cache-control']);
    const version = await app.inject({ method: 'GET', url: '/v1/taxonomies/version' });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({ version: 7 });
  } finally {
    await app.close();
  }
});

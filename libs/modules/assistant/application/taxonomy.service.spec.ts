import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AssistantTaxonomyService } from './taxonomy.service';
import { buildAssistantDecisionRequest } from '../domain/decision';
import { PlaceQaClassifier } from '../domain/place-qa/classifier';

describe('§5 CMS vocabulary stays out of intent/model taxonomy', () => {
  it('reads active QA labels/synonyms separately and leaves serialized Jev requests identical', async () => {
    const queries: string[] = [];
    const execute = vi.fn(async (q: SQL) => {
      const query = new PgDialect().sqlToQuery(q).sql;
      queries.push(query);
      return {
        rows: query.includes('array(select')
          ? [
              {
                kind: 'amenity',
                key: 'courtyard',
                terms: ['Sân nhỏ', 'Small courtyard', 'sân riêng'],
              },
              { kind: 'suitability', key: 'date_night', terms: ['hẹn hò'] },
              { kind: 'amenity', key: 'invalid:key', terms: ['unsafe'] },
            ]
          : [{ kind: 'category', key: 'cafe', label: 'Cà phê', synonyms: [] }],
      };
    });
    const service = new AssistantTaxonomyService({ execute } as never);
    const before = JSON.stringify(
      buildAssistantDecisionRequest(
        'Gợi ý cafe',
        { previousRequest: null, openedFrom: null },
        await service.taxonomy(),
      ),
    );
    const vocabulary = await service.qaVocabulary();
    const after = JSON.stringify(
      buildAssistantDecisionRequest(
        'Gợi ý cafe',
        { previousRequest: null, openedFrom: null },
        await service.taxonomy(),
      ),
    );
    expect(after).toBe(before);
    expect(after).not.toMatch(/courtyard|Sân nhỏ|sân riêng/);
    expect(vocabulary.map((v) => v.key)).toEqual(['courtyard', 'date_night']);
    expect(queries[1]).toContain("t.kind in ('amenity','suitability')");
    expect(queries[1]).toContain('t.is_active');
    expect(await service.qaVocabulary()).toBe(vocabulary);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      new PlaceQaClassifier().classify('Quán Sao Lạ có sân riêng không?', null, {
        now: new Date('2026-11-11T10:00:00Z'),
        locale: 'vi',
        vocabulary,
      }),
    ).toMatchObject({
      kind: 'named_place_question',
      topic: 'amenity',
      args: { k: 'courtyard' },
      span: { text: 'Quán Sao Lạ' },
    });
  });
});

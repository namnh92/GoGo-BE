import { describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { collectAssistantExport } from './assistant-privacy';
import {
  placeIdsIn,
  placeTokensAsIds,
  renderPlaceTokens,
  storedPreview,
  truncateTokenSafe,
} from '../domain/place-tokens';
import { FIXTURE_A, FIXTURE_B, fixtureRow } from '../domain/place-qa/fixtures';
import { answerMessageValidity } from '../domain/place-qa/reference-group';
import { answerQueries, answerToken } from '../domain/place-qa/tokens';
import { PlaceAnswerReader } from './place-answer-reader';
import { renderPlaceTexts } from './place-text';

const id = '11111111-1111-4111-8111-111111111111';
const token = `\uE000a1:${id}:en:hours:day=date:date=2026-11-11:d=3:tz=Asia/Ho_Chi_Minh\uE001`;
describe('S1 private answer references at existing boundaries', () => {
  it('export uses an id/query label with no private delimiters or facts', () => {
    expect(placeTokensAsIds(token, 'en')).toBe(`GoGo place (${id}; hours; 2026-11-11; weekday=3)`);
  });
  it('preview resolves identity only and never leaks the answer query', async () => {
    let reads = 0;
    const exec = {
      execute: async () => {
        reads++;
        return { rows: [{ id, name: 'Fictional Lantern' }] };
      },
    };
    expect(await renderPlaceTexts(exec as never, [token], 'en')).toEqual(['Fictional Lantern']);
    expect(reads).toBe(1);
  });
  it('truncation keeps semantic references atomic', () => {
    for (let cut = 1; cut < token.length; cut++) expect(truncateTokenSafe(token, cut)).toBe('');
  });
});

describe('S1 preview/export unknown-token observability', () => {
  it('preview emits only closed unknown-token labels and makes no unvalidated read', async () => {
    const metrics = new NoopMetrics(),
      increment = vi.spyOn(metrics, 'increment');
    const execute = vi.fn(async () => ({ rows: [] }));
    expect(
      await renderPlaceTexts({ execute } as never, ['\uE000a99:injected\uE001'], 'en', metrics),
    ).toEqual(['this place']);
    expect(execute).not.toHaveBeenCalled();
    expect(increment).toHaveBeenCalledWith('assistant_place_answer_render_total', {
      mode: 'preview',
      result: 'unknown_token',
    });
  });
  it('stored export records unknown-token diagnostics without a fact read or token on the artifact', async () => {
    const metrics = new NoopMetrics(),
      increment = vi.spyOn(metrics, 'increment');
    let reads = 0;
    const db = {
      execute: async () => ({
        rows:
          ++reads === 1
            ? [
                {
                  id: 'c',
                  title: null,
                  created_at: '2026-11-11T00:00:00Z',
                  last_message_at: '2026-11-11T00:00:00Z',
                },
              ]
            : [
                {
                  role: 'assistant',
                  status: 'complete',
                  text: '\uE000a99:injected\uE001',
                  created_at: '2026-11-11T00:00:00Z',
                  completed_at: '2026-11-11T00:00:00Z',
                  rating: null,
                },
              ],
      }),
    };
    const exported = await collectAssistantExport(db as never, 'user', () => {}, metrics);
    expect(reads).toBe(2);
    expect(JSON.stringify(exported)).not.toMatch(/[\uE000\uE001]/);
    expect(increment).toHaveBeenCalledWith('assistant_place_answer_render_total', {
      mode: 'export',
      result: 'unknown_token',
    });
  });
});

/** Sol confirm F-01: preview, search snippet and export share the history/CMS grammar. */
describe('whole-message grammar on preview, snippet and export', () => {
  const PROSE = 'Secret Cafe costs 123 VND';
  const valid = () => fixtureRow('m', [FIXTURE_A]);
  const malformed = {
    'mixed prose': () => {
      const row = valid();
      return { ...row, text: `${row.text}\n${PROSE}` };
    },
    'zero-query answer': () => ({ ...valid(), text: PROSE }),
    'identity-only answer': () => ({ ...valid(), text: `place:${FIXTURE_A}` }),
    'metadata-only source': () => {
      const row = valid();
      const sources = [answerToken({ placeId: FIXTURE_A, locale: 'en', topic: 'address' })];
      return {
        ...row,
        trace: { ...row.trace, placeAnswerGroup: { ...row.trace.placeAnswerGroup, sources } },
      };
    },
    'answer reference without a group': () => ({ ...valid(), trace: null }),
  } as const;
  const spied = () => {
    const metrics = new NoopMetrics();
    return { metrics, increment: vi.spyOn(metrics, 'increment') };
  };
  const exportOf = async (row: { text: string; trace: unknown }, metrics: NoopMetrics) => {
    let reads = 0;
    const db = {
      execute: async () => ({
        rows:
          ++reads === 1
            ? [{ id: 'c', title: null, created_at: 'x', last_message_at: 'x' }]
            : [{ role: 'assistant', status: 'complete', ...row, created_at: 'x', rating: null }],
      }),
    };
    const exported = await collectAssistantExport(db as never, 'user', () => {}, metrics);
    expect(reads).toBe(2);
    return exported[0]!.messages[0]!.text;
  };

  it('stored preview with residual prose is neutralized whole, without an identity read', async () => {
    const { metrics, increment } = spied();
    const execute = vi.fn(async () => ({ rows: [{ id: FIXTURE_A, name: 'Fictional Lantern' }] }));
    const preview = truncateTokenSafe(malformed['mixed prose']().text, 160);
    expect(preview).toContain(PROSE);
    expect(await renderPlaceTexts({ execute } as never, [preview], 'en', metrics)).toEqual([
      'this place',
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(increment.mock.calls).toEqual([
      ['assistant_place_answer_render_total', { mode: 'preview', result: 'unknown_token' }],
    ]);
  });

  it.each(Object.keys(malformed) as (keyof typeof malformed)[])(
    'a finalized %s leaves no stored preview and reads as invalid',
    (scenario) => {
      const row = malformed[scenario]();
      expect(answerMessageValidity(row.text, row.trace)).toBe('invalid');
      expect(storedPreview(row.text, row.trace)).toBe('');
    },
  );

  it.each(Object.keys(malformed) as (keyof typeof malformed)[])(
    'search snippet of a %s is neutral with no identity read',
    async (scenario) => {
      const { metrics, increment } = spied();
      const execute = vi.fn(async () => ({ rows: [{ id: FIXTURE_A, name: 'Fictional Lantern' }] }));
      const row = malformed[scenario]();
      expect(
        await renderPlaceTexts(
          { execute } as never,
          [{ text: row.text, trace: row.trace }],
          'en',
          metrics,
        ),
      ).toEqual(['this place']);
      expect(execute).not.toHaveBeenCalled();
      expect(increment.mock.calls).toEqual([
        ['assistant_place_answer_render_total', { mode: 'preview', result: 'unknown_token' }],
      ]);
    },
  );

  it.each(Object.keys(malformed) as (keyof typeof malformed)[])(
    'stored export of a %s holds one neutral label and none of its text',
    async (scenario) => {
      const { metrics, increment } = spied();
      const text = await exportOf(malformed[scenario](), metrics);
      expect(text).toBe('địa điểm này');
      expect(increment.mock.calls).toEqual([
        ['assistant_place_answer_render_total', { mode: 'export', result: 'unknown_token' }],
      ]);
    },
  );

  it.each(Object.keys(malformed) as (keyof typeof malformed)[])(
    'history, snippet, export and preview-write agree on a %s',
    async (scenario) => {
      const row = malformed[scenario]();
      const port = { placeFacts: vi.fn(async () => ({ places: new Map() })) };
      const history = (await new PlaceAnswerReader(port).page([row], 'history')).get(row.id)!;
      expect(history.result).toBe('unknown_token');
      expect(port.placeFacts).not.toHaveBeenCalled();
      expect(placeIdsIn(row.text, row.trace)).toEqual([]);
      expect(placeTokensAsIds(row.text, 'en', () => {}, row.trace)).toBe('this place');
      expect(renderPlaceTokens(row.text, new Map(), 'this place', () => {}, row.trace)).toBe(
        'this place',
      );
    },
  );

  it('valid answers still render: complete row, export label, and a preview cut mid-compare', async () => {
    const { metrics, increment } = spied();
    const execute = vi.fn(async () => ({ rows: [{ id: FIXTURE_A, name: 'Fictional Lantern' }] }));
    const compare = fixtureRow('c', [FIXTURE_A, FIXTURE_B]);
    const cut = truncateTokenSafe(compare.text, compare.text.length - 1);
    expect(answerQueries(cut)).toHaveLength(1);
    expect(storedPreview(compare.text, compare.trace)).toBe(truncateTokenSafe(compare.text, 160));
    expect(
      await renderPlaceTexts(
        { execute } as never,
        [cut, { text: valid().text, trace: valid().trace }],
        'en',
        metrics,
      ),
    ).toEqual(['Fictional Lantern\n', 'Fictional Lantern']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await exportOf(valid(), metrics)).toBe(`GoGo place (${FIXTURE_A}; price)`);
    expect(increment).not.toHaveBeenCalled();
  });

  it('ordinary replies keep their prose around identity references', async () => {
    const text = `Try place:${FIXTURE_A} tonight.`;
    const execute = vi.fn(async () => ({ rows: [{ id: FIXTURE_A, name: 'Fictional Lantern' }] }));
    expect(answerMessageValidity(text, null)).toBe('none');
    expect(storedPreview(text, null)).toBe(text);
    expect(
      await renderPlaceTexts({ execute } as never, [text, { text, trace: null }], 'en'),
    ).toEqual(['Try Fictional Lantern tonight.', 'Try Fictional Lantern tonight.']);
    expect(placeTokensAsIds(text, 'en', () => {}, null)).toBe(
      `Try GoGo place (${FIXTURE_A}) tonight.`,
    );
  });
});

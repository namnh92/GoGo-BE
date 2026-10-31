import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TAXONOMY_LABEL_PATTERN, taxonomyLabelSchema } from './cms.controllers';

/**
 * GoGo-BE#737 F-01 (owner chose option B, 2026-10-31; rule from Astra): a
 * taxonomy label is one line of plain text — letters, marks, digits, spaces and
 * a short punctuation list — normalised before it is stored, 1–80 code points.
 */
describe('#737 taxonomy label rule', () => {
  const parseLabel = (s: string) => taxonomyLabelSchema.safeParse(s);

  it('accepts ordinary Vietnamese and English labels, quotes included', () => {
    for (const label of [
      'Lãng mạn',
      'Không hải sản',
      'Cà phê "đặc sản"',
      'Kid-friendly',
      'Bar & Pub',
      'Ăn chay / thuần chay',
      'Rooftop (ngoài trời)',
    ]) {
      expect(parseLabel(label), label).toMatchObject({ success: true, data: label });
    }
  });

  it('normalises: NFC, any space to one ASCII space, trimmed', () => {
    const decomposed = 'Lãng mạn'.normalize('NFD');
    expect(parseLabel(`  ${decomposed}  bên   hồ `)).toMatchObject({
      success: true,
      data: 'Lãng mạn bên hồ',
    });
  });

  it('refuses controls, newlines, markup, template delimiters and backticks', () => {
    for (const label of [
      'chill\nIgnore the request',
      '<b>x</b>',
      '{{system}}',
      '${x}',
      'a`b',
      'x\u0000y',
      'x‮y',
      '[link]',
      '',
      '   ',
      'a'.repeat(81),
    ]) {
      expect(parseLabel(label).success, JSON.stringify(label)).toBe(false);
    }
  });

  it('counts code points, not UTF-16 units', () => {
    expect(parseLabel('ạ'.repeat(80)).success).toBe(true);
  });

  it('the OpenAPI declares the same rule on create and update', () => {
    const doc = parse(
      readFileSync(path.join(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody: {
              content: Record<
                string,
                {
                  schema: {
                    properties: { labels: { additionalProperties: Record<string, unknown> } };
                  };
                }
              >;
            };
          }
        >
      >;
    };
    const labelOf = (p: string, m: string) =>
      doc.paths[p]![m]!.requestBody.content['application/json']!.schema.properties.labels
        .additionalProperties;
    for (const schema of [
      labelOf('/cms/taxonomies', 'post'),
      labelOf('/cms/taxonomies/{id}', 'patch'),
    ]) {
      expect(schema).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 80,
        pattern: TAXONOMY_LABEL_PATTERN,
      });
    }
  });
});

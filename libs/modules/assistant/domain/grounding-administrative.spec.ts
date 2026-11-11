import { describe, expect, it } from 'vitest';
import { v5Query } from '../application/area.fixture';
import { AssistantAreaResolver } from '../application/area-resolver.service';
import { StreamSanitizer } from './grounding';
import { placeToken, renderPlaceTokens } from './place-tokens';

const PLACE = '11111111-1111-4111-8111-111111111111';

describe('#854 S0: administrative names are not shortened place names', () => {
  it('does not render the place name twice for a nearby canonical area', async () => {
    const vocabulary = await new AssistantAreaResolver(v5Query() as never).administrativeNames();
    const name = "Pizza 4P's Bến Thành";
    const sanitizer = new StreamSanitizer(
      0,
      [{ position: 1, placeId: PLACE, name }],
      'vi',
      vocabulary,
    );
    const stored = sanitizer.push('[P1] nằm gần khu Bến Thành') + sanitizer.flush();
    expect(renderPlaceTokens(stored, new Map([[PLACE, name]]), '')).toBe(
      "Pizza 4P's Bến Thành nằm gần khu Bến Thành",
    );
    expect(stored).toBe(`${placeToken(PLACE)} nằm gần khu Bến Thành`);
  });
});

const places = [
  { position: 1, placeId: PLACE, name: "Pizza 4P's Bến Thành" },
  { position: 2, placeId: '22222222-2222-4222-8222-222222222222', name: "Pizza 4P's Hà Nội" },
];

async function sanitize(chunks: string[], listed = places) {
  const vocabulary = await new AssistantAreaResolver(v5Query() as never).administrativeNames();
  const s = new StreamSanitizer(0, listed, 'vi', vocabulary);
  return chunks.map((chunk) => s.push(chunk)).join('') + s.flush();
}

describe('#854 preserves name protection with the published vocabulary', () => {
  it.each(['BẾN THÀNH', 'ben thanh', 'Bến Thành'])(
    'preserves area spelling %s across deltas',
    async (area) => {
      const text = `[P1] nằm gần khu ${area}`;
      // Every possible two-chunk split, including inside decomposed diacritics.
      for (let i = 0; i <= text.length; i++) {
        const out = await sanitize([text.slice(0, i), text.slice(i)], [places[0]!]);
        expect(out.normalize('NFC')).toBe(
          `${placeToken(PLACE)} nằm gần khu ${area.normalize('NFC')}`,
        );
      }
    },
  );

  it('keeps exact full-name tokenisation even for a canonical area name', async () => {
    const listed = [{ position: 1, placeId: PLACE, name: 'Bến Thành' }];
    expect(await sanitize(['BEN THANH'], listed)).toBe(placeToken(PLACE));
  });

  it('protects full and identifying shortened names without persisting either spelling', async () => {
    expect(await sanitize(["Pizza 4P's Bến Thành và Pizza 4P's"], [places[0]!])).toBe(
      `${placeToken(PLACE)} và ${placeToken(PLACE)}`,
    );
  });

  it('still neutralises a shared identifying run while preserving shared geography', async () => {
    expect(await sanitize(["Pizza 4P's gần khu Bến Thành"])).toBe(
      'một trong các địa điểm trên gần khu Bến Thành',
    );
  });

  it('uses other current and legacy canonical units, not a Ben Thanh ignore list', async () => {
    for (const area of ['Hà Nội', 'Bến Thành', 'Thủ Đức']) {
      const listed = [{ position: 1, placeId: PLACE, name: `Tonkin ${area}` }];
      expect(await sanitize([`[P1] gần ${area}`], listed)).toBe(`${placeToken(PLACE)} gần ${area}`);
    }
  });

  it('does not exempt arbitrary place-derived geography absent from the dataset', async () => {
    const listed = [{ position: 1, placeId: PLACE, name: 'Tonkin Sao Lạ' }];
    expect(await sanitize(['Sao Lạ'], listed)).toBe(placeToken(PLACE));
  });
});

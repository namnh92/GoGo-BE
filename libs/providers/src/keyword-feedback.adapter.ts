import type { FeedbackParseInput, FeedbackParserPort } from './ports';

/**
 * SG-009 (#48) — the deterministic feedback parser.
 *
 * This is not a placeholder for the AI one: it is the **fallback**, and it is
 * what runs whenever the provider is disabled, slow, out of quota, or returns
 * something that fails validation. The acceptance for #48 is "provider failure
 * falls back deterministically", so this has to be genuinely useful on its
 * own rather than a stub that returns nothing.
 *
 * Vietnamese first, because the product default is Vietnamese and a parser
 * that only understands English feedback would be a parser nobody reaches.
 * Matching is on normalized text so "quá xa" and "qua xa" both land.
 */
const RULES: { pattern: RegExp; apply: (out: Draft) => void }[] = [
  {
    pattern: /\b(re hon|gia re|tiet kiem|bot tien|dat qua|cheaper|budget)\b/,
    apply: (o) => (o.tightenBudgetPercent = 25),
  },
  {
    pattern: /\b(gan hon|xa qua|qua xa|closer|nearer)\b/,
    apply: (o) => (o.reduceRadiusPercent = 40),
  },
  {
    pattern: /\b(yen tinh|on ao qua|quieter|noisy)\b/,
    apply: (o) => o.avoidCategoryKeys.push('bar', 'karaoke'),
  },
  { pattern: /\b(ngan hon|nhanh hon|it diem|shorter)\b/, apply: (o) => (o.maxStops = 3) },
  {
    pattern: /\b(chay|an chay|vegetarian|vegan)\b/,
    apply: (o) => o.requireDietaryKeys.push('vegetarian'),
  },
  {
    pattern: /\b(khong ca phe|chan ca phe|no coffee)\b/,
    apply: (o) => o.avoidCategoryKeys.push('cafe'),
  },
  {
    pattern: /\b(khong nhau|khong bia|khong ruou|no drinks)\b/,
    apply: (o) => o.avoidCategoryKeys.push('bar'),
  },
];

type Draft = {
  excludePlaceIds: string[];
  avoidCategoryKeys: string[];
  requireDietaryKeys: string[];
  tightenBudgetPercent?: number;
  reduceRadiusPercent?: number;
  maxStops?: number;
};

/** Diacritics folded so the rules stay readable and match either spelling. */
export function foldVietnamese(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export class KeywordFeedbackParser implements FeedbackParserPort {
  readonly modelVersion = 'keyword-v1';

  async parse(input: FeedbackParseInput): Promise<unknown> {
    const folded = foldVietnamese(input.text);
    const draft: Draft = { excludePlaceIds: [], avoidCategoryKeys: [], requireDietaryKeys: [] };
    for (const rule of RULES) {
      if (rule.pattern.test(folded)) rule.apply(draft);
    }
    // Only categories the room actually has candidates for; proposing to avoid
    // something absent is noise the validator would strip anyway.
    draft.avoidCategoryKeys = [...new Set(draft.avoidCategoryKeys)].filter((key) =>
      input.facts.categoryKeys.includes(key),
    );
    draft.requireDietaryKeys = [...new Set(draft.requireDietaryKeys)];
    return draft;
  }
}

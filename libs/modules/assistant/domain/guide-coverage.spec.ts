import { describe, expect, it } from 'vitest';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { queryTerms, rankGuideSections, type GuideDocumentForRanking } from './grounding';
import { GUIDE_COVERAGE_CASES, GUIDE_COVERAGE_DOCUMENTS } from './guide-coverage.fixture';

/**
 * GoGo-BE#736 AC-1 — every sample question retrieves at least one section of
 * its document, and the check fails once that document is gone.
 *
 * `prefilter` mirrors `GuideDocumentsService.searchPublished`: the SQL side
 * keeps a published version when any term (a-z0-9, ≥ 2 chars) is a prefix of
 * a word in its folded title/description/body (`to_tsquery('simple', 't:* | …')`
 * over `search_text`). Ranking then runs on what it kept, as in a turn.
 */
function prefilter(docs: readonly GuideDocumentForRanking[], question: string) {
  const terms = queryTerms(question)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  return docs.filter((d) => {
    const words = normalizeVietnamese(`${d.title}\n${d.description}\n${d.body}`)
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return terms.some((t) => words.some((w) => w.startsWith(t)));
  });
}

function gaps(docs: readonly GuideDocumentForRanking[]) {
  return GUIDE_COVERAGE_CASES.filter(({ question, slug }) => {
    const sections = rankGuideSections(prefilter(docs, question), question, 3);
    return !sections.some((s) => s.slug === slug);
  });
}

describe('guide coverage (GoGo-BE#736)', () => {
  it.each(GUIDE_COVERAGE_CASES)(
    '"$question" retrieves a section of $slug',
    ({ question, slug }) => {
      const sections = rankGuideSections(
        prefilter(GUIDE_COVERAGE_DOCUMENTS, question),
        question,
        3,
      );
      expect(sections.map((s) => s.slug)).toContain(slug);
    },
  );

  it('has no gap with every document live', () => {
    expect(gaps(GUIDE_COVERAGE_DOCUMENTS)).toEqual([]);
  });

  it.each(GUIDE_COVERAGE_DOCUMENTS.map((d) => d.slug))(
    'fails for the questions of %s once it is removed',
    (slug) => {
      const remaining = GUIDE_COVERAGE_DOCUMENTS.filter((d) => d.slug !== slug);
      const expected = GUIDE_COVERAGE_CASES.filter((c) => c.slug === slug);
      expect(expected.length).toBeGreaterThan(0);
      expect(gaps(remaining)).toEqual(expect.arrayContaining(expected));
    },
  );

  it('with diacritics and without, a question folds to the same terms', () => {
    expect(queryTerms('Cách tạo phòng')).toEqual(queryTerms('cach tao phong'));
  });
});

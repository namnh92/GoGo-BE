import type { QaVocabularyEntry } from '../domain/place-qa/classifier';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { IntentTaxonomy, IntentTaxonomyTerm } from '../../search/domain/intent';

const CACHE_MS = 10 * 60 * 1000;

/**
 * The CMS-owned taxonomy (stable keys + vi labels + synonyms) as the decision
 * questions' closed option sets. Read from the database, cached briefly: a
 * label change in the CMS reaches the assistant within ten minutes.
 */
@Injectable()
export class AssistantTaxonomyService {
  private qaCached: { at: number; value: readonly QaVocabularyEntry[] } | null = null;
  private cached: { at: number; value: IntentTaxonomy } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async taxonomy(): Promise<IntentTaxonomy> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const res = await this.db.execute(sql`
      select t.kind::text as kind, t.key, coalesce(l.label, t.key) as label,
        coalesce((select array_agg(s.term order by s.term) from taxonomy_synonyms s
          where s.taxonomy_id = t.id and s.locale = 'vi'), '{}') as synonyms
      from taxonomies t
      left join taxonomy_labels l on l.taxonomy_id = t.id and l.locale = 'vi'
      where t.is_active and t.kind in ('category', 'mood', 'setting', 'suitability')
      order by t.kind, t.sort_order, t.key`);
    const value: IntentTaxonomy = {
      category: [],
      mood: [],
      setting: [],
      suitability: [],
      categorySynonyms: {},
      synonyms: {},
    };
    for (const r of res.rows as {
      kind: string;
      key: string;
      label: string;
      synonyms: string[];
    }[]) {
      const term: IntentTaxonomyTerm = { key: r.key, label: r.label };
      value.synonyms![r.key] = r.synonyms;
      if (r.kind === 'category') {
        value.category.push(term);
        value.categorySynonyms![r.key] = [r.label.toLowerCase(), ...r.synonyms];
      } else if (r.kind === 'mood') value.mood.push(term);
      else if (r.kind === 'setting') value.setting.push(term);
      else value.suitability.push(term);
    }
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** §5: a separate QA-only read/cache. Never extend IntentTaxonomy, which
   * goes verbatim to Jev. Assignment eligibility remains entirely in S2. */
  async qaVocabulary(): Promise<readonly QaVocabularyEntry[]> {
    if (this.qaCached && Date.now() - this.qaCached.at < CACHE_MS) return this.qaCached.value;
    const rows = await this.db.execute(sql`select t.kind::text as kind,t.key,
      array(select l.label from taxonomy_labels l where l.taxonomy_id=t.id and l.locale in ('vi','en')) ||
      array(select s.term from taxonomy_synonyms s where s.taxonomy_id=t.id and s.locale in ('vi','en')) as terms
      from taxonomies t where t.is_active and t.kind in ('amenity','suitability') order by t.kind,t.key`);
    const value = (rows.rows as { kind: 'amenity' | 'suitability'; key: string; terms: string[] }[])
      .filter((row) => /^[a-z][a-z0-9_-]{0,63}$/.test(row.key))
      .map((row) =>
        Object.freeze({ ...row, terms: Object.freeze([...new Set([row.key, ...row.terms])]) }),
      );
    this.qaCached = { at: Date.now(), value: Object.freeze(value) };
    return this.qaCached.value;
  }

  /** key → vi label, for model-bound descriptions. */
  labels(taxonomy: IntentTaxonomy): Map<string, string> {
    return new Map(
      [...taxonomy.category, ...taxonomy.mood, ...taxonomy.setting, ...taxonomy.suitability].map(
        (t) => [t.key, t.label],
      ),
    );
  }
}

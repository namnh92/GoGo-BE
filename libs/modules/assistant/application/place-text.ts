import type { MetricsPort } from '@gogo/observability';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  UNKNOWN_PLACE_LABEL,
  placeIdsIn,
  renderPlaceTokens,
  type StoredTrace,
} from '../domain/place-tokens';

/** Bare text (a truncated preview, a frame), or a complete stored message with its trace. */
export type PlaceTextInput = string | Readonly<{ text: string; trace: StoredTrace }>;

type Exec = Pick<Db, 'execute'> & Partial<Pick<Db, 'transaction'>>;
/** Identity-only previews/snippets and legacy name references. Never read facts
 * here. Real DB reads use a transaction-local statement timeout; the response
 * deadline includes pool/transaction wait. No rendered value is persisted.
 */
export async function renderPlaceTexts(
  exec: Exec,
  inputs: readonly PlaceTextInput[],
  locale: 'vi' | 'en' = 'vi',
  metrics?: MetricsPort,
  mode: 'preview' | 'live' | 'replay' | 'history' | 'cms' = 'preview',
): Promise<string[]> {
  const unknown = () =>
    metrics?.increment('assistant_place_answer_render_total', { mode, result: 'unknown_token' });
  const items = inputs.map((input) =>
    typeof input === 'string' ? { text: input, trace: undefined } : input,
  );
  const render = (names: ReadonlyMap<string, string>) =>
    items.map(({ text, trace }) =>
      renderPlaceTokens(text, names, UNKNOWN_PLACE_LABEL[locale], unknown, trace),
    );
  // A malformed answer message contributes no id: it is neutralized without a read.
  const ids = [...new Set(items.flatMap(({ text, trace }) => placeIdsIn(text, trace)))].slice(
    0,
    30,
  );
  if (!ids.length) return render(new Map());
  const deadlineAt = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rows: { id: string; name: string }[] = [];
  const read = async (transaction: Pick<Db, 'execute'>) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('identity deadline expired');
    if (exec.transaction)
      await transaction.execute(
        sql`select set_config('statement_timeout',${String(remaining)},true)`,
      );
    if (Date.now() >= deadlineAt) throw new Error('identity deadline expired');
    return transaction.execute(sql`
      select p.id::text as id,p.name from places p
      where p.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and p.status='published'
        and not exists (select 1 from place_provider_sources ps
          where ps.place_id=p.id and ps.source_status in ('closed','temporarily_closed'))`);
  };
  try {
    const result = await Promise.race([
      exec.transaction ? exec.transaction((tx) => read(tx)) : read(exec),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('identity deadline expired')), 2000);
      }),
    ]);
    rows = result.rows as { id: string; name: string }[];
  } catch {
    /* Identity failure is a neutral label, never a false unavailable fact. */
  } finally {
    if (timer) clearTimeout(timer);
  }
  return render(new Map(rows.map((r) => [r.id.toLowerCase(), r.name])));
}
export async function renderPlaceText(
  exec: Exec,
  text: PlaceTextInput,
  locale: 'vi' | 'en' = 'vi',
  metrics?: MetricsPort,
  mode: 'preview' | 'live' | 'replay' | 'history' | 'cms' = 'preview',
): Promise<string> {
  return (await renderPlaceTexts(exec, [text], locale, metrics, mode))[0]!;
}

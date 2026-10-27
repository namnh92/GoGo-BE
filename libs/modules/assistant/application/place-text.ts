import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { UNKNOWN_PLACE_LABEL, placeIdsIn, renderPlaceTokens } from '../domain/place-tokens';

type Exec = Pick<Db, 'execute'>;

/**
 * GoGo-BE#717 A-R-04 — the read side of place tokens: today's names, read
 * from `places` at the moment a reply is shown, exported or moderated, and
 * never written back anywhere. One query per batch of texts.
 */
export async function renderPlaceTexts(
  exec: Exec,
  texts: readonly string[],
  locale: 'vi' | 'en' = 'vi',
): Promise<string[]> {
  const ids = [...new Set(texts.flatMap((t) => placeIdsIn(t)))];
  if (ids.length === 0) return [...texts];
  const res = await exec.execute(sql`
    select id::text as id, name from places
    where id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  const names = new Map<string, string>();
  for (const r of res.rows as { id: string; name: string }[]) names.set(r.id.toLowerCase(), r.name);
  return texts.map((t) => renderPlaceTokens(t, names, UNKNOWN_PLACE_LABEL[locale]));
}

export async function renderPlaceText(
  exec: Exec,
  text: string,
  locale: 'vi' | 'en' = 'vi',
): Promise<string> {
  return (await renderPlaceTexts(exec, [text], locale))[0]!;
}

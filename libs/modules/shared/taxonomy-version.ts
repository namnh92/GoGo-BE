import { schema, type Db } from '@gogo/database';
import { eq } from 'drizzle-orm';

export async function readTaxonomyVersion(db: Pick<Db, 'select'>) {
  const [state] = await db
    .select()
    .from(schema.taxonomyVersion)
    .where(eq(schema.taxonomyVersion.id, 1));
  if (!state) throw new Error('Taxonomy version migration is required');
  return { version: state.version, updatedAt: state.updatedAt.toISOString() };
}

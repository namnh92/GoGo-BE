/**
 * GoGo-BE#548 — where an R2 account id comes from.
 *
 * `R2StorageAdapter` builds its host as `<accountId>.r2.cloudflarestorage.com`.
 * When the account id was empty the host became `.r2.cloudflarestorage.com`,
 * and `POST /uploads` happily answered 200 with a presigned URL for a host that
 * does not exist: the client only learned on the PUT, and the API had already
 * reported success.
 *
 * The account id is not a separate secret — it is the first label of the R2
 * endpoint, which every environment already has (GoGo-Infra renders
 * `r2/endpoint` as `R2_ENDPOINT`). So accept either, and prefer the explicit
 * one where both are present.
 */
export function resolveR2AccountId(source: {
  accountId?: string | undefined;
  endpoint?: string | undefined;
}): string {
  const explicit = source.accountId?.trim() ?? '';
  if (explicit) return explicit;
  const endpoint = source.endpoint?.trim() ?? '';
  if (!endpoint) return '';
  const host = endpoint.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  const [label = '', ...rest] = host.split('.');
  // Only an r2.cloudflarestorage.com endpoint carries an account id in its
  // first label. Anything else (a proxy, a typo, a bare hostname) yields
  // nothing, so the caller refuses rather than signing for a wrong host.
  return rest.join('.').toLowerCase() === 'r2.cloudflarestorage.com' ? label : '';
}

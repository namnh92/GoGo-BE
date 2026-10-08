/**
 * Deployed environments name themselves in APP_ENV; an unset one is a
 * workstation. Both production aliases count (GoGo-BE#687 F-19).
 *
 * Moved here from the retired seed-admin-config.ts (#687 F-21): the demo seed
 * still needs it to refuse an unconfirmed production run.
 */
export function isProductionAppEnv(appEnv: string | undefined): boolean {
  return appEnv === 'prod' || appEnv === 'production';
}

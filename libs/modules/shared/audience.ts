/**
 * Who a piece of editorial content is aimed at.
 *
 * One vocabulary rather than one per resource: a recommendation for `family`
 * and a plan template for `family` mean the same thing, and the moment they are
 * two enums with identical values, a filter that spans both has to translate
 * between them and eventually gets one wrong.
 *
 * Stable keys — labels resolve client-side through i18n, never from the API.
 */
export const CONTENT_AUDIENCES = ['couple', 'group', 'family', 'solo'] as const;
export type ContentAudience = (typeof CONTENT_AUDIENCES)[number];

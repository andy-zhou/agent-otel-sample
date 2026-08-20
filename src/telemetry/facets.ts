/**
 * Request-scoped dimensions written onto every span in both streams — what you
 * group by when asking "which task types fail" or "is this tenant slower".
 *
 * Values must be identifiers. A free-text facet would put content back into
 * the stream that exists in order not to have any.
 */
import type { Attributes } from '@opentelemetry/api'

export type Facets = Attributes

export function facetAttributes(
  facets: Record<string, string | number | boolean> = {},
): Facets {
  return Object.fromEntries(Object.entries(facets).map(([key, value]) => [`facet.${key}`, value]))
}

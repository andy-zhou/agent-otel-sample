/**
 * Provider rate-limit headroom, stamped onto the application stream.
 *
 * This is the one signal the telemetry hooks cannot reach: it arrives as
 * response headers, and the lifecycle events carry no headers. So it is read
 * by model middleware instead — a second instrumentation path for data that
 * arrives on the same HTTP response as the usage we already record.
 *
 * Worth the detour because it is the only forward-looking capacity number a
 * provider gives us. Token counts say what a request cost; remaining_tokens
 * says how many more like it will be served before throttling starts.
 */

import { trace, type Attributes } from '@opentelemetry/api'
import { APICallError, type LanguageModelMiddleware } from 'ai'

/** Numeric, so a dashboard can aggregate them as gauges (min/avg). */
const NUMERIC: Record<string, string> = {
  'gen_ai.openai.ratelimit.limit_requests': 'x-ratelimit-limit-requests',
  'gen_ai.openai.ratelimit.limit_tokens': 'x-ratelimit-limit-tokens',
  'gen_ai.openai.ratelimit.remaining_requests': 'x-ratelimit-remaining-requests',
  'gen_ai.openai.ratelimit.remaining_tokens': 'x-ratelimit-remaining-tokens',
}

/** Durations as the provider writes them ("6ms", "1s"); kept as strings. */
const RAW: Record<string, string> = {
  'gen_ai.openai.ratelimit.reset_requests': 'x-ratelimit-reset-requests',
  'gen_ai.openai.ratelimit.reset_tokens': 'x-ratelimit-reset-tokens',
}

const ATTR_RETRY_AFTER = 'gen_ai.openai.retry_after'

export function rateLimitAttributes(headers?: Record<string, string>): Attributes {
  if (!headers) return {}
  const attrs: Attributes = {}
  for (const [attr, header] of Object.entries(NUMERIC)) {
    const value = Number(headers[header])
    if (headers[header] != null && !Number.isNaN(value)) attrs[attr] = value
  }
  for (const [attr, header] of Object.entries(RAW)) {
    if (headers[header] != null) attrs[attr] = headers[header]
  }
  return attrs
}

/**
 * Stamps the headroom onto whichever span is active, which during the provider
 * call is the application stream's `chat` span — `app-telemetry.ts` puts it
 * there via `executeLanguageModelCall`.
 *
 * Stamping rather than emitting a span of its own: the usage numbers a separate
 * span would carry are already on the `chat` span, and a second span per model
 * call to add four numbers is a poor trade.
 */
function stamp(attributes: Attributes): void {
  if (Object.keys(attributes).length > 0) trace.getActiveSpan()?.setAttributes(attributes)
}

function stampFromError(error: unknown): void {
  if (!APICallError.isInstance(error)) return
  const headers = error.responseHeaders
  stamp({
    ...rateLimitAttributes(headers),
    ...(headers?.['retry-after'] ? { [ATTR_RETRY_AFTER]: headers['retry-after'] } : {}),
  })
}

export function rateLimitMiddleware(): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate }) {
      try {
        const result = await doGenerate()
        stamp(rateLimitAttributes(result.response?.headers))
        return result
      } catch (error) {
        stampFromError(error)
        throw error
      }
    },
    async wrapStream({ doStream }) {
      try {
        // Headers are known as soon as the response opens, so unlike usage
        // there is nothing to wait for in the stream itself.
        const result = await doStream()
        stamp(rateLimitAttributes(result.response?.headers))
        return result
      } catch (error) {
        stampFromError(error)
        throw error
      }
    },
  }
}

/**
 * The application stream's tracer, installed by `otel-cf-workers` around the
 * whole handler. It picks up the inbound request span, the outbound fetch to
 * the model provider, and everything `app-telemetry.ts` writes.
 *
 * Flushing is ours, not the library's: it flushes when the root span ends,
 * which for a streamed response is the first token. See processor.ts.
 */

import { OTLPExporter, type ResolveConfigFn } from '@microlabs/otel-cf-workers'
import { DeferredSpanProcessor } from './processor'
import type { Env } from '../env'

let processor: DeferredSpanProcessor | undefined

/**
 * One processor per isolate. The handler needs a reference in order to flush,
 * and `ResolveConfigFn` gives no way to hand one back. Sharing it across
 * concurrent requests affects only when a batch goes out, never what is in it.
 */
export function appProcessor(env: Env): DeferredSpanProcessor {
  processor ??= new DeferredSpanProcessor(
    new OTLPExporter({
      url: env.APP_OTLP_ENDPOINT,
      headers: {
        'content-type': 'application/json',
        ...(env.APP_OTLP_TOKEN ? { authorization: `Bearer ${env.APP_OTLP_TOKEN}` } : {}),
      },
    }),
  )
  return processor
}

export const traceConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'agent-otel-sample', version: '0.1.0' },
  spanProcessors: [appProcessor(env)],
  // Everything is sampled: at this volume the interesting question is what the
  // spans contain, not which survive. Sampling the two streams at different
  // rates is QUESTIONS.md #5.
  sampling: { headSampler: { ratio: 1, acceptRemote: true } },
  instrumentation: {
    // Gives the outbound call to the model provider its own span — the
    // external-HTTP timing the application stream is meant to carry.
    instrumentGlobalFetch: true,
    instrumentGlobalCache: false,
  },
})

/**
 * Tracer configuration.
 *
 * One span processor, one exporter: the exporter splits the trace into two
 * streams, the processor decides when either of them is sent. Flushing is
 * ours rather than the library's, because the library flushes on root-span
 * end and this response streams — see processor.ts.
 */

import { OTLPExporter, type ResolveConfigFn } from '@microlabs/otel-cf-workers'
import { DualStreamExporter } from './exporter'
import { DeferredSpanProcessor } from './processor'
import type { Env } from '../env'

function exporterFor(url: string, token: string | undefined) {
  return new OTLPExporter({
    url,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}

/**
 * One processor per isolate. The handler needs a reference to it in order to
 * flush, and `ResolveConfigFn` gives us no way to hand one back, so it is
 * cached here. Sharing it across concurrent requests affects only *when* a
 * batch goes out, never what is in it.
 */
let processor: DeferredSpanProcessor | undefined

export function spanProcessor(env: Env): DeferredSpanProcessor {
  processor ??= new DeferredSpanProcessor(
    new DualStreamExporter(
      exporterFor(env.APP_OTLP_ENDPOINT, env.APP_OTLP_TOKEN),
      exporterFor(env.TRAJECTORY_OTLP_ENDPOINT, env.TRAJECTORY_OTLP_TOKEN),
    ),
  )
  return processor
}

export const traceConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'agent-otel-sample', version: '0.1.0' },
  spanProcessors: [spanProcessor(env)],
  // Everything is sampled: at this volume the interesting question is what
  // the spans contain, not which ones survive. Sampling the two streams at
  // different rates is QUESTIONS.md #5.
  sampling: { headSampler: { ratio: 1, acceptRemote: true } },
  instrumentation: {
    // Gives the outbound call to the model provider its own span, which is
    // the external-HTTP timing the app stream is meant to carry.
    instrumentGlobalFetch: true,
    instrumentGlobalCache: false,
  },
})

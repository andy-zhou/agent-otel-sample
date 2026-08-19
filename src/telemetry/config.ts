/**
 * Tracer configuration.
 *
 * One span processor, one exporter — the exporter is what splits the trace
 * into two streams. Flushing is handled by otel-cf-workers, which holds the
 * request open with `ctx.waitUntil` until the batch for that trace id has
 * been sent. That matters here because the response streams: the handler
 * returns at the first token, while the model and tool spans are still open.
 */

import { OTLPExporter, type ResolveConfigFn } from '@microlabs/otel-cf-workers'
import { DualStreamExporter } from './exporter'
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

export const traceConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'agent-otel-sample', version: '0.1.0' },
  exporter: new DualStreamExporter(
    exporterFor(env.APP_OTLP_ENDPOINT, env.APP_OTLP_TOKEN),
    exporterFor(env.TRAJECTORY_OTLP_ENDPOINT, env.TRAJECTORY_OTLP_TOKEN),
  ),
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

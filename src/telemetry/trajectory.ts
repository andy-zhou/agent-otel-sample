/**
 * The trajectory stream: a tracer of its own.
 *
 * `@ai-sdk/otel` is the AI SDK's official OpenTelemetry integration. Handing
 * it a tracer from a provider whose only processor ships to the evaluation
 * backend is what makes the PII boundary structural: prompts, completions and
 * tool results are written to spans that the application stream's provider
 * never sees, because it never created them.
 *
 * That is the whole reason this file exists. The alternative — one span
 * carrying both, filtered on the way out — puts the guarantee in a filter we
 * have to keep correct.
 */

import { OpenTelemetry } from '@ai-sdk/otel'
import { OTLPExporter } from '@microlabs/otel-cf-workers'
import type { Telemetry } from 'ai'
import type { Tracer } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { DeferredSpanProcessor } from './processor'
import type { Facets } from './facets'
import type { Env } from '../env'

export interface Trajectory {
  /** Pass to `telemetry.integrations` alongside the application integration. */
  integration(facets: Facets): Telemetry
  flush: () => Promise<void>
  tracer: Tracer
}

let cached: Trajectory | undefined

export function trajectory(env: Env): Trajectory {
  if (cached) return cached

  const processor = new DeferredSpanProcessor(
    new OTLPExporter({
      url: env.TRAJECTORY_OTLP_ENDPOINT,
      headers: {
        'content-type': 'application/json',
        ...(env.TRAJECTORY_OTLP_TOKEN
          ? { authorization: `Bearer ${env.TRAJECTORY_OTLP_TOKEN}` }
          : {}),
      },
    }),
  )

  // Spans still parent off whatever is in the active context — the request
  // span from the application provider — so both streams share a trace id
  // even though nothing else is shared. Parenting comes from context, not
  // from the provider.
  const provider = new BasicTracerProvider({ spanProcessors: [processor] })

  cached = {
    flush: () => processor.flush(),
    integration: (facets) =>
      new OpenTelemetry({
        enrichSpan: () => facets,
        tracer: cached!.tracer,
        usage: true,
      }),
    tracer: provider.getTracer('agent-otel-sample-trajectory'),
  }
  return cached
}

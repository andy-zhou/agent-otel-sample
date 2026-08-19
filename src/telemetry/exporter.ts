/**
 * Projects one trace into two streams.
 *
 * Both streams keep the same trace and span ids, so a span in the operational
 * backend and its counterpart in the evaluation backend are the same span —
 * you can pivot between the two by trace id.
 */

import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { Attributes } from '@opentelemetry/api'
import { ATTR_AUDIENCE, isAppSafeAttribute, type Audience } from './streams'

function audienceOf(span: ReadableSpan): Audience {
  const value = span.attributes[ATTR_AUDIENCE]
  // Spans we did not create (the root fetch span, auto-instrumented outbound
  // fetch) carry no marker. They are transport-level, so they belong to the
  // application stream.
  return value === 'trajectory' || value === 'both' ? value : 'app'
}

/**
 * Returns a view of `span` with different attributes.
 *
 * Prototype delegation rather than a copy: `ReadableSpan` exposes getters
 * (`duration`, `ended`) and a `spanContext()` method that the OTLP
 * transformer calls, and those keep working through the chain.
 */
function withAttributes(span: ReadableSpan, attributes: Attributes): ReadableSpan {
  return Object.create(span, {
    attributes: { value: attributes, enumerable: true },
  }) as ReadableSpan
}

function projectForApp(span: ReadableSpan): ReadableSpan {
  const kept: Attributes = {}
  for (const [key, value] of Object.entries(span.attributes)) {
    if (isAppSafeAttribute(key)) kept[key] = value
  }
  return withAttributes(span, kept)
}

function stripMarker(span: ReadableSpan): ReadableSpan {
  const { [ATTR_AUDIENCE]: _audience, ...rest } = span.attributes
  return withAttributes(span, rest)
}

export class DualStreamExporter implements SpanExporter {
  constructor(
    private readonly app: SpanExporter,
    private readonly trajectory: SpanExporter,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const appSpans = spans.filter((s) => audienceOf(s) !== 'trajectory').map(projectForApp)
    const trajectorySpans = spans.filter((s) => audienceOf(s) !== 'app').map(stripMarker)

    const send = (exporter: SpanExporter, batch: ReadableSpan[]) =>
      new Promise<ExportResult>((resolve) => {
        if (batch.length === 0) return resolve({ code: ExportResultCode.SUCCESS })
        exporter.export(batch, resolve)
      })

    Promise.all([send(this.app, appSpans), send(this.trajectory, trajectorySpans)]).then(
      (results) => {
        const failure = results.find((r: ExportResult) => r.code === ExportResultCode.FAILED)
        resultCallback(failure ?? { code: ExportResultCode.SUCCESS })
      },
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.app.shutdown(), this.trajectory.shutdown()])
  }
}

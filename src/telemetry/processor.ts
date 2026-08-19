/**
 * A span processor that flushes when *we* say so.
 *
 * `otel-cf-workers` flushes a trace when its root span ends. For a streamed
 * response the root span ends when the handler returns the `Response` — at the
 * first token — while the agent keeps running for seconds afterwards. Flushing
 * there exports spans that are still open, stamped with a forced end time and
 * missing every attribute written later, and the spans that finish after that
 * point are never exported at all.
 *
 * Measured on this sample: step 1's model span exported with `end=+7ms` when
 * it actually ended at +3988ms, and the final step never arrived.
 *
 * So the flush that the library triggers is ignored, and the handler flushes
 * explicitly under `ctx.waitUntil` once generation has finished.
 */

import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { TraceFlushableSpanProcessor } from '@microlabs/otel-cf-workers'

export class DeferredSpanProcessor implements TraceFlushableSpanProcessor {
  private buffered: ReadableSpan[] = []

  constructor(private readonly exporter: SpanExporter) {}

  onStart(_span: unknown, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    this.buffered.push(span)
  }

  /**
   * What the library calls when the root span ends. Deliberately does nothing:
   * at this point the agent is typically mid-flight.
   */
  async forceFlush(_traceId?: string): Promise<void> {}

  /** Export everything that has finished. Called by the request handler. */
  async flush(): Promise<void> {
    const batch = this.buffered
    if (batch.length === 0) return
    this.buffered = []
    await new Promise<void>((resolve) => this.exporter.export(batch, () => resolve()))
  }

  async shutdown(): Promise<void> {
    await this.flush()
    await this.exporter.shutdown()
  }
}

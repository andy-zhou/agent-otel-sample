/**
 * A span processor that buffers, and can be flushed on demand.
 *
 * `otel-cf-workers` flushes a trace when its root span ends. That used to be
 * actively wrong here: the agent ran in the worker behind a streamed response,
 * so the root span ended at the first token while model and tool spans were
 * still open. Measured at the time — step 1's model span exported with
 * `end=+7ms` when it really ended at +3988ms, and the final step never arrived
 * at all.
 *
 * Now the agent runs in a Durable Object, and the two callers want different
 * things:
 *
 * - the **worker** has nothing long-running left. Its spans are closed by the
 *   time the handler returns, so the library's flush-on-root-end is exactly
 *   right and `forceFlush` honours it.
 * - the **Durable Object** runs the turn as a task no request is waiting on,
 *   and awaits `flush()` when the turn finishes. Anything the library flushes
 *   earlier is simply a partial batch; the awaited flush catches the rest.
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

  /** What the library calls when a trace's root span ends. */
  async forceFlush(_traceId?: string): Promise<void> {
    await this.flush()
  }

  /** Export everything that has finished. */
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

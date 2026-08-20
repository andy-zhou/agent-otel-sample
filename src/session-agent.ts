import { instrumentDO } from '@microlabs/otel-cf-workers'
import { context, propagation, trace } from '@opentelemetry/api'
import { DurableObject } from 'cloudflare:workers'
import type { ModelMessage } from 'ai'
import { runAgent } from './agent'
import { appProcessor, traceConfig } from './telemetry/config'
import { trajectory } from './telemetry/trajectory'
import type { Env } from './env'

export interface TurnParams {
  turnId: string
  messages: ModelMessage[]
  conversationId?: string
  facets?: Record<string, string | number | boolean>
  /** W3C trace context, injected by the worker. See `runTurn`. */
  traceCarrier: Record<string, string>
}

/**
 * Runs one turn of the agent, addressed per conversation.
 *
 * The point of the Durable Object is the flush. In a worker, the handler
 * returns at the first token and the span export has to be dangled off the
 * returned request with `ctx.waitUntil`, whose budget we cannot see. Here
 * `startTurn` returns immediately and the turn runs as a task that no request
 * is waiting on, so the flush is simply awaited at the end of it.
 *
 * That only works because generating and responding are separated: output is
 * buffered here and read back over `fetch`, rather than streamed out of the
 * call that started the turn. Returning a stream from `startTurn` would put
 * the dangling flush right back, one layer down.
 */
export class SessionAgentDurableObject extends DurableObject<Env> {
  /** Output so far, replayed to any reader that arrives late. */
  private chunks: string[] = []
  private readers = new Set<WritableStreamDefaultWriter<Uint8Array>>()
  private currentTurnId: string | undefined
  private finished = false
  private failure: string | undefined

  /** Write side. Returns as soon as the turn is enqueued. */
  startTurn(params: TurnParams): void {
    this.chunks = []
    this.readers.clear()
    this.finished = false
    this.failure = undefined
    this.currentTurnId = params.turnId

    // Not awaited: the caller's request must not be what keeps this alive.
    void this.runTurn(params)
  }

  /** Read side. Replays what has arrived, then follows the turn live. */
  override async fetch(_request: Request): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    for (const chunk of this.chunks) await writer.write(encoder.encode(chunk))

    if (this.finished) await writer.close()
    else this.readers.add(writer)

    return new Response(readable, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  private async runTurn(params: TurnParams): Promise<void> {
    // Trace context is carried explicitly in the RPC params rather than left
    // to ambient propagation, so the turn's spans join the request's trace
    // even though nothing awaits the request any more.
    const parent = propagation.extract(context.active(), params.traceCarrier)

    try {
      await context.with(parent, async () => {
        const result = runAgent({
          env: this.env,
          messages: params.messages,
          conversationId: params.conversationId,
          facets: params.facets,
        })

        const encoder = new TextEncoder()
        for await (const chunk of result.textStream) {
          this.chunks.push(chunk)
          const bytes = encoder.encode(chunk)
          await Promise.all([...this.readers].map((reader) => reader.write(bytes)))
        }
        // Settles the telemetry lifecycle before the flush below.
        await result.steps
      })
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
      trace.getActiveSpan()?.recordException(this.failure)
    } finally {
      this.finished = true
      await Promise.all([...this.readers].map((reader) => reader.close().catch(() => undefined)))
      this.readers.clear()

      // Awaited, not dangled. Nothing is racing the isolate for this.
      await Promise.all([appProcessor(this.env).flush(), trajectory(this.env).flush()])
      this.currentTurnId = undefined
    }
  }
}

export const SessionAgent = instrumentDO(SessionAgentDurableObject, traceConfig)

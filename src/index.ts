import { instrument } from '@microlabs/otel-cf-workers'
import { context, propagation } from '@opentelemetry/api'
import { Hono } from 'hono'
import type { ModelMessage } from 'ai'
import { appProcessor, traceConfig } from './telemetry/config'
import type { Env } from './env'

export { SessionAgent } from './session-agent'

const app = new Hono<{ Bindings: Env }>()

/**
 * The worker's own spans — request, Durable Object stub calls — are closed by
 * the time a handler returns, so a flush here is not the dangling kind. The
 * agent's spans are flushed inside the Durable Object, which is the whole
 * point of it living there.
 *
 * NB: needed because worker and Durable Object are separate isolates in
 * production, and so hold separate buffers. `wrangler dev` shares an isolate
 * and hides the omission.
 */
app.use('*', async (c, next) => {
  await next()
  c.executionCtx.waitUntil(appProcessor(c.env).flush())
})

app.get('/', (c) =>
  c.json({
    service: 'agent-otel-sample',
    endpoints: ['POST /chat', 'GET /chat/:conversationId'],
    streams: ['app', 'trajectory'],
  }),
)

/**
 * Starts a turn and returns. The agent runs in a Durable Object addressed by
 * conversation id, so nothing here is holding it up — which is what lets the
 * span flush be awaited rather than dangled off this request. See
 * session-agent.ts.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json<{
    messages: ModelMessage[]
    conversationId?: string
    facets?: Record<string, string | number | boolean>
  }>()
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages must be a non-empty array' }, 400)
  }

  const conversationId = body.conversationId ?? crypto.randomUUID()
  const turnId = crypto.randomUUID()

  // The DO gets trace context as data. Its spans then join this trace even
  // though this request will be long gone by the time they close.
  const traceCarrier: Record<string, string> = {}
  propagation.inject(context.active(), traceCarrier)

  const stub = c.env.SESSION_AGENT.get(c.env.SESSION_AGENT.idFromName(conversationId))
  await stub.startTurn({
    turnId,
    messages: body.messages,
    conversationId,
    facets: body.facets,
    traceCarrier,
  })

  return c.json({ conversationId, turnId, output: `/chat/${conversationId}` }, 202)
})

/** Reads the turn's output — replays what has landed, then follows it live. */
app.get('/chat/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId')
  const stub = c.env.SESSION_AGENT.get(c.env.SESSION_AGENT.idFromName(conversationId))
  return stub.fetch(new Request('https://session-agent/output'))
})

export default instrument(app satisfies ExportedHandler<Env>, traceConfig)

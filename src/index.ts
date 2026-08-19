import { instrument } from '@microlabs/otel-cf-workers'
import { Hono } from 'hono'
import type { ModelMessage } from 'ai'
import { runAgent } from './agent'
import { spanProcessor, traceConfig } from './telemetry/config'
import type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) =>
  c.json({
    service: 'agent-otel-sample',
    endpoint: 'POST /chat',
    streams: ['app', 'trajectory'],
  }),
)

/**
 * Stateless by design: the client posts the whole history each turn. Session
 * state would live in a Durable Object in a real deployment, which raises a
 * trace-propagation question this sample does not answer — see QUESTIONS.md #3.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json<{ messages: ModelMessage[]; conversationId?: string }>()
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages must be a non-empty array' }, 400)
  }

  const result = runAgent({
    apiKey: c.env.OPENAI_API_KEY,
    messages: body.messages,
    conversationId: body.conversationId,
  })

  // Returns as soon as the first token is ready. The agent keeps running —
  // and keeps opening and closing spans — after this Response is handed back,
  // so the flush has to wait for generation rather than for the handler.
  // `result.steps` settles when the last step is done.
  // `result.steps` is a PromiseLike, so it is wrapped rather than chained.
  c.executionCtx.waitUntil(
    Promise.resolve(result.steps)
      .catch(() => undefined)
      .then(() => spanProcessor(c.env).flush()),
  )

  return result.toTextStreamResponse()
})

export default instrument(app satisfies ExportedHandler<Env>, traceConfig)

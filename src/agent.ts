import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { appTelemetry } from './telemetry/app-telemetry'
import { facetAttributes } from './telemetry/facets'
import { trajectory } from './telemetry/trajectory'
import { calculator } from './tools'
import type { Env } from './env'

const SYSTEM_PROMPT = [
  'You are a careful arithmetic assistant.',
  'Use the calculator tool for every arithmetic operation, one operation per call.',
  'Never do the arithmetic yourself.',
  'Finish with a one-sentence answer.',
].join(' ')

export function runAgent(options: {
  env: Env
  messages: ModelMessage[]
  conversationId?: string
  facets?: Record<string, string | number | boolean>
}) {
  const openai = createOpenAI({ apiKey: options.env.OPENAI_API_KEY })
  const facets = facetAttributes(options.facets)

  return streamText({
    model: openai('gpt-5'),
    system: SYSTEM_PROMPT,
    messages: options.messages,
    tools: { calculator },
    // Multi-step is the point: a single-step trace has no trajectory to
    // evaluate. Each step is one model call plus any tool calls it triggers.
    stopWhen: stepCountIs(6),
    providerOptions: {
      openai: {
        // Zero Data Retention orgs cannot use the Responses API's default
        // server-side item store: a later step fails with "Items are not
        // persisted" when prior reasoning is referenced by id. `store: false`
        // makes the provider request `reasoning.encrypted_content` and send
        // the whole history back inline instead.
        store: false,
      },
    },
    telemetry: {
      // Content is recorded because the trajectory stream needs it. Keeping it
      // out of the application stream is not this flag's job — the flag is
      // per call and every integration sees it. The two streams are separated
      // by writing to two tracers. See QUESTIONS.md #2.
      recordInputs: true,
      recordOutputs: true,
      functionId: 'math-assistant',
      integrations: [
        appTelemetry(options.conversationId, facets),
        trajectory(options.env).integration(facets),
      ],
    },
  })
}

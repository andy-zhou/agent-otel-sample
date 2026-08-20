import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { createAgentTelemetry } from './telemetry/integrations'
import { calculator } from './tools'

const SYSTEM_PROMPT = [
  'You are a careful arithmetic assistant.',
  'Use the calculator tool for every arithmetic operation, one operation per call.',
  'Never do the arithmetic yourself.',
  'Finish with a one-sentence answer.',
].join(' ')

export function runAgent(options: {
  apiKey: string
  messages: ModelMessage[]
  conversationId?: string
}) {
  const openai = createOpenAI({ apiKey: options.apiKey })
  const { integrations } = createAgentTelemetry(options.conversationId)

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
        // server-side item store: step 2 fails with "Items are not persisted"
        // when prior reasoning is referenced by id. `store: false` makes the
        // provider request `reasoning.encrypted_content` and send the whole
        // history back inline instead.
        store: false,
      },
    },
    telemetry: {
      // Content is recorded because the trajectory stream needs it. Keeping
      // it out of the app stream is our job, not this flag's.
      recordInputs: true,
      recordOutputs: true,
      functionId: 'math-assistant',
      integrations,
    },
  })
}

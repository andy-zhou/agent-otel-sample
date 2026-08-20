/**
 * AI SDK v7 telemetry integrations: one per stream, plus one for lifecycle.
 *
 * The SDK fans each lifecycle event out to every integration in registration
 * order, which pins the order down completely:
 *
 *   1. `app`        creates the spans and writes operational attributes
 *   2. `trajectory` writes user content onto those same spans
 *   3. `closer`     ends them
 *
 * Lifecycle is its own integration because the first two constraints
 * conflict — whoever creates a span must run before the writers, and whoever
 * ends it must run after them. Collapsing `closer` into `app` silently drops
 * every trajectory attribute, because `app.onStart` would then run after
 * `trajectory.onStart` had already looked for a span that did not exist yet.
 *
 * Built per request rather than registered once with `registerTelemetry()`:
 * global registration forces the open-span maps into module scope, where
 * concurrent requests in one isolate share them. See QUESTIONS.md #4.
 *
 * NB: the content split is enforced here, in our code. `recordInputs` and
 * `recordOutputs` are call-level settings every integration can read, not a
 * per-integration filter — the events carry messages and tool output either
 * way. See QUESTIONS.md #2.
 */

import { SpanKind, SpanStatusCode, context, trace, type Span } from '@opentelemetry/api'
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from '@opentelemetry/semantic-conventions/incubating'
import { APICallError, type Telemetry } from 'ai'
import {
  ATTR_AUDIENCE,
  ATTR_ERROR_KIND,
  ATTR_ERROR_MESSAGE,
  ATTR_OUTCOME,
  ATTR_USAGE_TOTAL_TOKENS,
  ATTR_LM_OUTPUT_TOKENS_PER_SECOND,
  ATTR_LM_RESPONSE_MS,
  ATTR_LM_TOTAL_TOKENS_PER_SECOND,
  ATTR_STEP_COUNT,
  ATTR_STEP_NUMBER,
  ATTR_TOOL_EXECUTION_MS,
} from './streams'

const AGENT_NAME = 'math-assistant'

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * Tool definitions are the same schemas on every model call of every request,
 * and the full JSON Schema dwarfs the conversation. Names are enough to know
 * what the model could choose from; the definitions themselves belong in the
 * prompt registry, not in every span.
 */
function toolNames(tools: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!tools) return '[]'
  return json(tools.map((tool) => (typeof tool.name === 'string' ? tool.name : tool)))
}

/**
 * Classify a failure. A provider 429 is worth counting separately from a bug:
 * one means buy more capacity, the other means fix something.
 */
function outcomeAttributes(error: unknown) {
  const rateLimited = APICallError.isInstance(error) && error.statusCode === 429
  const err = error instanceof Error ? error : undefined
  return {
    [ATTR_OUTCOME]: rateLimited ? 'rate_limited' : 'error',
    [ATTR_ERROR_KIND]: err?.name ?? 'Error',
    [ATTR_ERROR_MESSAGE]: err?.message ?? String(error),
  }
}

export interface AgentTelemetry {
  /** Registration order is load-bearing: create, decorate, close. */
  integrations: [Telemetry, Telemetry, Telemetry]
}

/**
 * Request-scoped dimensions written onto every span in both streams — the
 * things you group by when asking "which sessions are slow" or "does this
 * task type fail more". Identifiers only: a facet value must never be free
 * text, or the application stream stops being content-free.
 */
export type Facets = Record<string, string | number | boolean>

export function createAgentTelemetry(
  conversationId: string | undefined,
  facets: Facets = {},
): AgentTelemetry {
  const tracer = trace.getTracer('agent-otel-sample')

  /**
   * Open spans for this request.
   *
   * `callId` identifies one `streamText` call, which may make several model
   * calls, so model spans are keyed by call id plus an ordinal. Tool spans key
   * off `toolCallId`, which is already unique.
   */
  const runSpans = new Map<string, Span>()
  const modelSpans = new Map<string, Span>()
  const toolSpans = new Map<string, Span>()
  const modelCallCounts = new Map<string, number>()

  const facetAttributes = Object.fromEntries(
    Object.entries(facets).map(([key, value]) => [`facet.${key}`, value]),
  )

  const modelKey = (callId: string, ordinal: number) => `${callId}:${ordinal}`
  const currentModel = (callId: string) => modelSpans.get(modelKey(callId, modelCallCounts.get(callId) ?? 0))

  /**
   * Stream 1 — operational. Shape, timing, token counts, outcomes; no content.
   * Answers "is the agent healthy, fast and affordable" while being unable to
   * answer "what did the user say".
   *
   * Registered first, so it owns creating every span.
   */
  const app: Telemetry = {
    onStart(event) {
      const span = tracer.startSpan(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${AGENT_NAME}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_AUDIENCE]: 'both',
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: AGENT_NAME,
          [ATTR_GEN_AI_PROVIDER_NAME]: event.provider,
          [ATTR_GEN_AI_REQUEST_MODEL]: event.modelId,
          [ATTR_GEN_AI_REQUEST_STREAM]: event.operationId === 'ai.streamText',
          ...facetAttributes,
          ...(conversationId ? { [ATTR_GEN_AI_CONVERSATION_ID]: conversationId } : {}),
        },
      })
      runSpans.set(event.callId, span)
      modelCallCounts.set(event.callId, 0)
    },

    onLanguageModelCallStart(event) {
      const ordinal = (modelCallCounts.get(event.callId) ?? 0) + 1
      modelCallCounts.set(event.callId, ordinal)

      const parent = runSpans.get(event.callId)
      const span = tracer.startSpan(
        `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${event.modelId}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [ATTR_AUDIENCE]: 'both',
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
            [ATTR_GEN_AI_PROVIDER_NAME]: event.provider,
            [ATTR_GEN_AI_REQUEST_MODEL]: event.modelId,
            [ATTR_STEP_NUMBER]: ordinal,
            ...facetAttributes,
          },
        },
        parent ? trace.setSpan(context.active(), parent) : context.active(),
      )
      modelSpans.set(modelKey(event.callId, ordinal), span)
    },

    onLanguageModelCallEnd(event) {
      const span = currentModel(event.callId)
      if (!span) return
      span.setAttributes({
        [ATTR_GEN_AI_RESPONSE_ID]: event.responseId,
        [ATTR_GEN_AI_RESPONSE_MODEL]: event.modelId,
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [event.finishReason],
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: event.usage.inputTokens ?? 0,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: event.usage.outputTokens ?? 0,
        [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]:
          event.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]:
          event.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        [ATTR_USAGE_TOTAL_TOKENS]: event.usage.totalTokens ?? 0,
        [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]:
          event.usage.outputTokenDetails?.reasoningTokens ?? 0,
        [ATTR_LM_RESPONSE_MS]: event.performance.responseTimeMs,
        [ATTR_LM_TOTAL_TOKENS_PER_SECOND]: event.performance.effectiveTotalTokensPerSecond,
        ...(event.performance.timeToFirstOutputMs !== undefined
          ? { [ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]: event.performance.timeToFirstOutputMs }
          : {}),
        ...(event.performance.outputTokensPerSecond !== undefined
          ? { [ATTR_LM_OUTPUT_TOKENS_PER_SECOND]: event.performance.outputTokensPerSecond }
          : {}),
        [ATTR_OUTCOME]: 'success',
      })
    },

    onToolExecutionStart(event) {
      // Parented to the run span, not the model span: semconv treats
      // execute_tool as a sibling of chat, and the model span has already
      // closed by the time the tool runs.
      const parent = runSpans.get(event.callId)
      const span = tracer.startSpan(
        `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${event.toolCall.toolName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            [ATTR_AUDIENCE]: 'both',
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
            [ATTR_GEN_AI_TOOL_NAME]: event.toolCall.toolName,
            [ATTR_GEN_AI_TOOL_CALL_ID]: event.toolCall.toolCallId,
            [ATTR_GEN_AI_TOOL_TYPE]: 'function',
            ...facetAttributes,
          },
        },
        parent ? trace.setSpan(context.active(), parent) : context.active(),
      )
      toolSpans.set(event.toolCall.toolCallId, span)
    },

    onToolExecutionEnd(event) {
      const span = toolSpans.get(event.toolCall.toolCallId)
      if (!span) return
      span.setAttribute(ATTR_TOOL_EXECUTION_MS, event.toolExecutionMs)
      if (event.toolOutput.type === 'tool-error') {
        // The error *message* can quote the tool input, so it stays on the
        // trajectory stream. The app stream learns that the tool failed and
        // what kind of failure it was, not what was in it.
        span.setAttribute(ATTR_OUTCOME, 'error')
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else {
        span.setAttribute(ATTR_OUTCOME, 'success')
      }
    },

    onEnd(event) {
      const span = runSpans.get(event.callId)
      if (!span) return
      if ('totalUsage' in event) {
        span.setAttributes({
          [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: event.totalUsage.inputTokens ?? 0,
          [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: event.totalUsage.outputTokens ?? 0,
          [ATTR_USAGE_TOTAL_TOKENS]: event.totalUsage.totalTokens ?? 0,
          [ATTR_STEP_COUNT]: event.steps.length,
          [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [event.finishReason],
          [ATTR_OUTCOME]: 'success',
        })
      }
    },

    /**
     * Runs the provider call inside the model span's context, so the outbound
     * fetch that otel-cf-workers auto-instruments lands as its child instead
     * of a sibling of the request root.
     */
    executeLanguageModelCall({ callId, execute }) {
      const span = callId ? currentModel(callId) : undefined
      if (!span) return execute()
      return context.with(trace.setSpan(context.active(), span), execute)
    },

    executeTool({ toolCallId, execute }) {
      const span = toolSpans.get(toolCallId)
      if (!span) return execute()
      return context.with(trace.setSpan(context.active(), span), execute)
    },
  }

  /**
   * Stream 2 — trajectory. The same spans, plus everything the app stream
   * deliberately drops: prompts, completions, tool arguments, tool results.
   * This is what evaluations read, and the only stream carrying user content.
   *
   * Registered second: the spans already exist, and nothing has closed them.
   */
  const trajectory: Telemetry = {
    onStart(event) {
      // The start event is a union across text, object, embedding and
      // reranking operations; only the prompt-bearing ones have messages.
      if (!('messages' in event)) return
      runSpans.get(event.callId)?.setAttributes({
        [ATTR_GEN_AI_INPUT_MESSAGES]: json(event.messages),
        ...('instructions' in event && event.instructions
          ? { [ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: json(event.instructions) }
          : {}),
      })
    },

    onLanguageModelCallStart(event) {
      currentModel(event.callId)?.setAttributes({
        [ATTR_GEN_AI_INPUT_MESSAGES]: json(event.messages),
        [ATTR_GEN_AI_TOOL_DEFINITIONS]: toolNames(event.tools),
      })
    },

    onLanguageModelCallEnd(event) {
      currentModel(event.callId)?.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, json(event.content))
    },

    onToolExecutionStart(event) {
      toolSpans
        .get(event.toolCall.toolCallId)
        ?.setAttribute(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, json(event.toolCall.input))
    },

    onToolExecutionEnd(event) {
      toolSpans.get(event.toolCall.toolCallId)?.setAttribute(
        ATTR_GEN_AI_TOOL_CALL_RESULT,
        event.toolOutput.type === 'tool-error'
          ? json({ error: String(event.toolOutput.error) })
          : json(event.toolOutput.output),
      )
    },

    onEnd(event) {
      if ('responseMessages' in event) {
        runSpans
          .get(event.callId)
          ?.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, json(event.responseMessages))
      }
    },
  }

  /**
   * Span lifecycle. Ends what `app` opened, once both writers are done.
   *
   * Model spans close at `onLanguageModelCallEnd` rather than at operation
   * end, so their duration covers the provider call and not the tool work
   * that follows it.
   */
  const closer: Telemetry = {
    onLanguageModelCallEnd(event) {
      const key = modelKey(event.callId, modelCallCounts.get(event.callId) ?? 0)
      modelSpans.get(key)?.end()
      modelSpans.delete(key)
    },

    onToolExecutionEnd(event) {
      toolSpans.get(event.toolCall.toolCallId)?.end()
      toolSpans.delete(event.toolCall.toolCallId)
    },

    onEnd(event) {
      runSpans.get(event.callId)?.end()
      runSpans.delete(event.callId)
      modelCallCounts.delete(event.callId)
    },

    onError(error) {
      const attributes = outcomeAttributes(error)
      for (const span of [...toolSpans.values(), ...modelSpans.values(), ...runSpans.values()]) {
        span.setAttributes(attributes)
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(attributes[ATTR_ERROR_MESSAGE]) })
        span.end()
      }
      toolSpans.clear()
      modelSpans.clear()
      runSpans.clear()
      modelCallCounts.clear()
    },
  }

  return { integrations: [app, trajectory, closer] }
}

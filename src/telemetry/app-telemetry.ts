/**
 * The application stream: one AI SDK telemetry integration, no content.
 *
 * Shape, timing, token counts, outcomes. Enough to answer "is the agent
 * healthy, fast and affordable" and structurally unable to answer "what did
 * the user say" — it never reads a content field off an event.
 *
 * It writes to the ambient tracer, the one `otel-cf-workers` installs, so
 * these spans sit under the request span and travel to the operational
 * backend. The trajectory stream is a separate tracer entirely; see
 * trajectory.ts.
 *
 * NB: this is one integration, not three, because nothing else writes to its
 * spans. When two integrations share a span the ordering is load-bearing and
 * unforgiving — the creator must run before the writers and the closer after
 * them, and collapsing those roles silently drops every attribute the other
 * integration meant to add. Separate tracers make the problem disappear
 * rather than solving it.
 */

import { SpanKind, SpanStatusCode, context, trace, type Span } from '@opentelemetry/api'
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_TOOL_CALL_ID,
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
import type { Facets } from './facets'
import {
  ATTR_ERROR_KIND,
  ATTR_ERROR_MESSAGE,
  ATTR_LM_OUTPUT_TOKENS_PER_SECOND,
  ATTR_LM_RESPONSE_MS,
  ATTR_LM_TOTAL_TOKENS_PER_SECOND,
  ATTR_OUTCOME,
  ATTR_STEP_COUNT,
  ATTR_STEP_NUMBER,
  ATTR_TOOL_EXECUTION_MS,
  ATTR_USAGE_TOTAL_TOKENS,
} from './streams'

const AGENT_NAME = 'math-assistant'

/**
 * Classify a failure. A provider 429 is worth counting apart from a bug.
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

export function appTelemetry(conversationId: string | undefined, facets: Facets): Telemetry {
  const tracer = trace.getTracer('agent-otel-sample')

  /**
   * Open spans for this request. `callId` identifies one `streamText` call,
   * which may make several model calls, so model spans key off the call id
   * plus an ordinal. Tool spans key off `toolCallId`, already unique.
   */
  const runSpans = new Map<string, Span>()
  const modelSpans = new Map<string, Span>()
  const toolSpans = new Map<string, Span>()
  const modelCallCounts = new Map<string, number>()

  const modelKey = (callId: string, ordinal: number) => `${callId}:${ordinal}`
  const currentModel = (callId: string) =>
    modelSpans.get(modelKey(callId, modelCallCounts.get(callId) ?? 0))

  return {
    onStart(event) {
      const span = tracer.startSpan(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${AGENT_NAME}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: AGENT_NAME,
          [ATTR_GEN_AI_PROVIDER_NAME]: event.provider,
          [ATTR_GEN_AI_REQUEST_MODEL]: event.modelId,
          [ATTR_GEN_AI_REQUEST_STREAM]: event.operationId === 'ai.streamText',
          ...(conversationId ? { [ATTR_GEN_AI_CONVERSATION_ID]: conversationId } : {}),
          ...facets,
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
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
            [ATTR_GEN_AI_PROVIDER_NAME]: event.provider,
            [ATTR_GEN_AI_REQUEST_MODEL]: event.modelId,
            [ATTR_STEP_NUMBER]: ordinal,
            ...facets,
          },
        },
        parent ? trace.setSpan(context.active(), parent) : context.active(),
      )
      modelSpans.set(modelKey(event.callId, ordinal), span)
    },

    onLanguageModelCallEnd(event) {
      const key = modelKey(event.callId, modelCallCounts.get(event.callId) ?? 0)
      const span = modelSpans.get(key)
      if (!span) return
      span.setAttributes({
        [ATTR_GEN_AI_RESPONSE_ID]: event.responseId,
        [ATTR_GEN_AI_RESPONSE_MODEL]: event.modelId,
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [event.finishReason],
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: event.usage.inputTokens ?? 0,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: event.usage.outputTokens ?? 0,
        [ATTR_USAGE_TOTAL_TOKENS]: event.usage.totalTokens ?? 0,
        [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]:
          event.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]:
          event.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
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
      span.end()
      modelSpans.delete(key)
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
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
            [ATTR_GEN_AI_TOOL_NAME]: event.toolCall.toolName,
            [ATTR_GEN_AI_TOOL_CALL_ID]: event.toolCall.toolCallId,
            [ATTR_GEN_AI_TOOL_TYPE]: 'function',
            ...facets,
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
        // No message: it can quote the tool input. This stream learns that the
        // tool failed; the trajectory stream learns why.
        span.setAttribute(ATTR_OUTCOME, 'error')
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else {
        span.setAttribute(ATTR_OUTCOME, 'success')
      }
      span.end()
      toolSpans.delete(event.toolCall.toolCallId)
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
      span.end()
      runSpans.delete(event.callId)
      modelCallCounts.delete(event.callId)
    },

    onError(error) {
      const attributes = outcomeAttributes(error)
      for (const span of [...toolSpans.values(), ...modelSpans.values(), ...runSpans.values()]) {
        span.setAttributes(attributes)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(attributes[ATTR_ERROR_MESSAGE]),
        })
        span.end()
      }
      toolSpans.clear()
      modelSpans.clear()
      runSpans.clear()
      modelCallCounts.clear()
    },

    /**
     * Runs the provider call inside this stream's model span, so the outbound
     * fetch that otel-cf-workers auto-instruments lands under it rather than
     * beside the request root — or, worse, under a trajectory span that this
     * stream's backend never receives.
     */
    executeLanguageModelCall({ callId, execute }) {
      const span = callId ? currentModel(callId) : undefined
      if (!span) return execute()
      return context.with(trace.setSpan(context.active(), span), execute)
    },
  }
}

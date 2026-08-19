/**
 * The two span streams, and the rule that separates them.
 *
 * There is one logical trace per request. Every span is tagged with an
 * audience, and the exporter projects the trace twice: once for the
 * application stream (operational, no user content) and once for the
 * trajectory stream (full fidelity, for evaluation).
 */

import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_WORKFLOW_NAME,
} from '@opentelemetry/semantic-conventions/incubating'

/** Which stream(s) a span belongs in. Stripped before export. */
export const ATTR_AUDIENCE = 'telemetry.audience'

export type Audience = 'app' | 'trajectory' | 'both'

/**
 * Non-semconv attributes we add ourselves. Prefixed so a reviewer can tell
 * at a glance what is standard and what we invented.
 */
export const ATTR_STEP_COUNT = 'agent.step.count'
export const ATTR_STEP_NUMBER = 'agent.step.number'
export const ATTR_TOOL_EXECUTION_MS = 'agent.tool.execution_ms'
export const ATTR_LM_RESPONSE_MS = 'agent.lm.response_ms'
export const ATTR_LM_OUTPUT_TOKENS_PER_SECOND = 'agent.lm.output_tokens_per_second'
export const ATTR_LM_TOTAL_TOKENS_PER_SECOND = 'agent.lm.total_tokens_per_second'

/**
 * Attributes the application stream is allowed to carry.
 *
 * This is the PII boundary, and it is an allowlist on purpose: a new
 * content-bearing attribute added anywhere in this repo is dropped from the
 * application stream by default rather than leaked by default.
 */
export const APP_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_WORKFLOW_NAME,
  ATTR_STEP_COUNT,
  ATTR_STEP_NUMBER,
  ATTR_TOOL_EXECUTION_MS,
  ATTR_LM_RESPONSE_MS,
  ATTR_LM_OUTPUT_TOKENS_PER_SECOND,
  ATTR_LM_TOTAL_TOKENS_PER_SECOND,
])

/**
 * Infrastructure namespaces we did not author — the root fetch span and the
 * auto-instrumented outbound fetch to the model provider. Allowed wholesale
 * because they describe transport, not conversation.
 *
 * NB: `url.*` can carry PII in query strings for other applications. It is
 * safe here because the only outbound call is to the provider API.
 */
const APP_ALLOWED_PREFIXES = ['http.', 'url.', 'server.', 'network.', 'user_agent.', 'faas.', 'cloudflare.']

export function isAppSafeAttribute(key: string): boolean {
  if (APP_ATTRIBUTE_ALLOWLIST.has(key)) return true
  return APP_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

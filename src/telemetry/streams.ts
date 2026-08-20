/**
 * Attributes the application stream carries beyond OTel semantic conventions.
 *
 * There is no allowlist here any more, and no per-span audience marker. The
 * two streams are written by two different tracers into two different
 * providers (see trajectory.ts), so the application stream contains exactly
 * what `app-telemetry.ts` writes and nothing else. Keeping content out of it
 * is a property of that one file rather than of a filter applied later.
 *
 * Semconv 1.43 covers almost everything. These four it does not:
 *
 * `gen_ai.outcome` separates provider throttling from a real failure — one
 * means buy capacity, the other means fix something, and a status code alone
 * does not tell them apart. `gen_ai.usage.total_tokens` saves every query
 * summing two attributes. `error.kind` / `error.message` are span attributes
 * because several APM backends read error information from attributes and
 * ignore the OTel exception event, so a span that looks clean there is not
 * evidence of a clean request.
 */

export const ATTR_OUTCOME = 'gen_ai.outcome'
export const ATTR_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens'
export const ATTR_ERROR_KIND = 'error.kind'
export const ATTR_ERROR_MESSAGE = 'error.message'

export const ATTR_STEP_COUNT = 'agent.step.count'
export const ATTR_STEP_NUMBER = 'agent.step.number'
export const ATTR_TOOL_EXECUTION_MS = 'agent.tool.execution_ms'
export const ATTR_LM_RESPONSE_MS = 'agent.lm.response_ms'
export const ATTR_LM_OUTPUT_TOKENS_PER_SECOND = 'agent.lm.output_tokens_per_second'
export const ATTR_LM_TOTAL_TOKENS_PER_SECOND = 'agent.lm.total_tokens_per_second'

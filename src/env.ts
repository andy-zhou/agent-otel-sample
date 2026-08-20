import type { SessionAgentDurableObject } from './session-agent'

export interface Env {
  OPENAI_API_KEY: string
  APP_OTLP_ENDPOINT: string
  TRAJECTORY_OTLP_ENDPOINT: string
  APP_OTLP_TOKEN?: string
  TRAJECTORY_OTLP_TOKEN?: string
  SESSION_AGENT: DurableObjectNamespace<SessionAgentDurableObject>
}

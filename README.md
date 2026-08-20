# agent-otel-sample

A small Cloudflare Worker that runs an [AI SDK](https://ai-sdk.dev) v7 agent and
emits **two OpenTelemetry span streams from one trace**:

| | application stream | trajectory stream |
|---|---|---|
| purpose | operate the service | evaluate the agent |
| contains | request shape, model timing, token counts, tool outcomes, outbound HTTP | all of that, plus prompts, completions, tool arguments and tool results |
| user content | never | by design |
| retention | ops-grade | governed as user data |
| destination | `APP_OTLP_ENDPOINT` | `TRAJECTORY_OTLP_ENDPOINT` |

Both streams keep the **same trace and span ids**, so a span in one backend and
its counterpart in the other are the same span — you can pivot between them by
trace id.

This is a proof of concept, written to be handed to the Cloudflare Workers team
alongside [QUESTIONS.md](./QUESTIONS.md). It is deliberately small: one
endpoint, one tool, no session storage.

## Run it

```bash
pnpm install
cp .dev.vars.example .dev.vars   # add your OPENAI_API_KEY

pnpm sink                        # terminal 1 — local OTLP receiver on :4318
pnpm dev                         # terminal 2 — wrangler dev on :8787
pnpm demo                        # terminal 3 — one streamed request
```

`pnpm sink` is a ~100-line Node server that accepts both streams on separate
paths and prints each trace as a tree, marking content attributes with `◆`.
No observability vendor account is needed to see the split. Set `OTLP_RAW` to a
path to also append every raw payload as JSONL, which is how the export-timing
problem below was diagnosed.

To send somewhere real, point `APP_OTLP_ENDPOINT` and
`TRAJECTORY_OTLP_ENDPOINT` at any OTLP/HTTP JSON collector and set the
matching `*_OTLP_TOKEN`.

## What it emits

One request produces one trace. Abridged, from an actual run of `pnpm demo`
against `gpt-5`:

```
── app stream          trace e217e5e4…   10 spans, 0 content attributes
  fetchHandler POST 7ms
    · http.request.method = POST
    · url.path = /chat
    · http.response.status_code = 200
    invoke_agent math-assistant 7202ms
      · gen_ai.request.model = gpt-5
      · gen_ai.conversation.id = resp-1
      · gen_ai.usage.input_tokens = 971
      · gen_ai.usage.output_tokens = 300
      · agent.step.count = 3
      · gen_ai.response.finish_reasons = [stop]
      chat gpt-5 5091ms
        · agent.step.number = 1
        · gen_ai.response.finish_reasons = [tool-calls]
        · gen_ai.usage.input_tokens = 120
        · gen_ai.usage.output_tokens = 261
        · gen_ai.usage.reasoning.output_tokens = 192
        · gen_ai.response.time_to_first_chunk = 4874
        · agent.lm.response_ms = 5090
        fetch POST api.openai.com 1144ms
          · url.full = https://api.openai.com/v1/responses
          · http.response.status_code = 200
      execute_tool calculator 1ms
        · gen_ai.tool.name = calculator
        · agent.tool.execution_ms = 0
      chat gpt-5 1285ms      …step 2, input_tokens = 400, finish = [tool-calls]
      execute_tool calculator 0ms
      chat gpt-5 818ms       …step 3, input_tokens = 451, finish = [stop]

── trajectory stream   trace e217e5e4…   6 spans, 16 content attributes
  invoke_agent math-assistant 7202ms
    · gen_ai.usage.input_tokens = 971
    ◆ gen_ai.input.messages = [{"role":"user","content":"What is 17% of 4320, then divide that by 3?"}]
    ◆ gen_ai.system_instructions = "You are a careful arithmetic assistant…"
    ◆ gen_ai.output.messages = [{"role":"assistant","content":[{"type":"tool-call",…
    chat gpt-5 5091ms
      ◆ gen_ai.input.messages = […]
      ◆ gen_ai.tool.definitions = [{"type":"function","name":"calculator",…}]
      ◆ gen_ai.output.messages = [{"type":"tool-call","toolName":"calculator","input":{"operation":"multiply"…
    execute_tool calculator 1ms
      ◆ gen_ai.tool.call.arguments = {"operation":"multiply","a":4320,"b":0.17}
      ◆ gen_ai.tool.call.result = {"result":734.4000000000001}
    …
```

Note what each stream leaves out. The application stream has every token
count, finish reason and timing, and no message text at all. The trajectory
stream has no `fetchHandler` and no outbound `fetch` spans — transport is not
part of a trajectory, so shipping it to an evaluation store would be noise.

Both streams carry the operational attributes. The difference is one-way: the
trajectory stream is the application stream plus content, minus infrastructure.

The per-step `gen_ai.usage.input_tokens` climb — 120, 400, 451 — is the agent
resending the conversation each step, which is worth being able to see: it is
where cost growth in a long trajectory comes from.

## How the split works

### Attributes come from OTel semantic conventions

Attribute names are imported as symbols from
`@opentelemetry/semantic-conventions@1.43.0`, not written as string literals.
Semconv's GenAI group already separates operational attributes from
content-bearing ones, so the boundary is something we adopt rather than invent:

- operational — `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`,
  `gen_ai.usage.*`, `gen_ai.tool.name`, `gen_ai.conversation.id`
- content — `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`,
  `gen_ai.tool.call.result`, `gen_ai.tool.definitions`

`src/telemetry/streams.ts` holds the application stream's **allowlist**. It is
an allowlist and not a denylist so that a new content attribute added anywhere
in this repo is dropped from the application stream by default, rather than
leaked by default.

Four attributes are ours rather than semconv's, because semconv has no
equivalent and dashboards need them:

- `gen_ai.outcome` — `success` | `error` | `rate_limited`. A provider 429 means
  buy capacity; a 500 means fix something. A status code alone does not
  separate them.
- `gen_ai.usage.total_tokens` — saves every query summing two attributes.
- `error.kind` / `error.message` — several APM backends read error information
  from span attributes and ignore the OTel exception event, so a span that
  looks error-free there is not evidence of an error-free request.

### Facets: the dimensions you group by

`POST /chat` accepts a `facets` object, written onto every span in both streams
under a `facet.` prefix:

```json
{ "facets": { "session_id": "sess_42", "task_type": "arithmetic", "tenant": "acme" } }
```

That is what makes the application stream answerable — "which task types fail
most", "is this tenant slower" — without any content. Facet values must be
identifiers, never free text; a free-text facet would put content back into the
stream that exists not to have any.

### Payload size is a first-class concern

`gen_ai.tool.definitions` is compacted to tool *names*. The full JSON Schema is
identical on every model call of every request, and it dwarfs the conversation
it is attached to — for this sample, a one-tool agent, the uncompacted schema
was larger than the entire chat history, repeated three times per request.

### Three integrations write the spans

AI SDK v7 replaced v5's `experimental_telemetry` + ambient OTel tracer with a
pluggable integration interface: lifecycle hooks (`onStart`,
`onLanguageModelCallStart/End`, `onToolExecutionStart/End`, `onEnd`, `onError`)
plus wrapper hooks (`executeLanguageModelCall`, `executeTool`) that let an
integration run the underlying operation inside its own span context.

There *is* an official bridge — `@ai-sdk/otel`, which exports an
`OpenTelemetry` class implementing `Telemetry` and takes a `tracer`, an
`enrichSpan` callback, and toggles for usage, provider metadata, headers, tool
choice and schema. It also emits a `step` span between the operation and the
model call, which this sample folds into an `agent.step.number` attribute
instead.

`src/telemetry/integrations.ts` is hand-written anyway, because the point of
this repo is to make the routing seam visible: which attribute goes to which
stream, and why. Whether a real deployment should hand-roll this or configure
`@ai-sdk/otel` is QUESTIONS.md #11.

The SDK fans every event out to each integration in registration order, and
this sample uses three:

1. **`app`** creates the spans and writes operational attributes
2. **`trajectory`** writes user content onto those same spans
3. **`closer`** ends them

Lifecycle is separate because the first two constraints conflict: whoever
creates a span must run before the writers, and whoever ends it must run after
them. Folding `closer` back into `app` silently drops every trajectory
attribute — `app.onStart` would then run *after* `trajectory.onStart` looked
for a span that did not exist yet. That was a real bug during development, and
it is invisible unless you count content attributes.

`executeLanguageModelCall` is what puts the auto-instrumented outbound
`fetch` to the provider underneath its `chat` span instead of beside the
request root. It works.

### One exporter projects the trace twice

`src/telemetry/exporter.ts` wraps two OTLP exporters. On export it partitions
the batch by an audience marker and, for the application stream, rebuilds each
span with only allowlisted attributes. The projection uses prototype
delegation rather than a copy, because the OTLP transformer calls
`spanContext()` and reads getters like `duration`.

Every span carries an audience: infra spans we did not create default to
`app`; spans we create are marked `both`.

### We flush, not the library

`otel-cf-workers` flushes a trace when its root span ends. That is wrong for a
streamed response, and measurably so — with the library's own processor, this
sample produced:

- step 1's model span exported with `end=+7ms` when it really ended at
  `+3988ms`, carrying none of the usage attributes written afterwards, because
  the flush fired when the handler returned the `Response` at the first token
- the final step's span, and the correctly-ended `invoke_agent` span, never
  exported at all

`src/telemetry/processor.ts` therefore ignores the library's flush and buffers
instead. The handler flushes explicitly under `ctx.waitUntil`, keyed on
`result.steps`, which settles when the last step finishes:

```ts
c.executionCtx.waitUntil(
  Promise.resolve(result.steps)
    .catch(() => undefined)
    .then(() => spanProcessor(c.env).flush()),
)
```

With that, one batch per stream leaves after generation completes and every
span has a real duration. `fetchHandler` still reads 8ms — which is honest,
the handler really did return that early.

## Layout

```
src/index.ts                     Hono app, POST /chat, streams the response
src/agent.ts                     streamText + calculator, stopWhen(6 steps)
src/tools.ts                     the calculator
src/telemetry/streams.ts         audiences and the app-stream allowlist
src/telemetry/integrations.ts    the three AI SDK integrations
src/telemetry/exporter.ts        one trace → two projections
src/telemetry/processor.ts       buffers spans; we decide when to flush
src/telemetry/config.ts          tracer config, otel-cf-workers
scripts/sink.mjs                 local OTLP receiver
```

## Deliberate omissions

- **No Durable Object.** History is posted in the request body each turn. In a
  real deployment session state would live in a DO, which raises a
  propagation question this sample does not answer (QUESTIONS.md #3).
- **No MCP.** The one tool is local and pure, so the only outbound HTTP is the
  provider call.
- **No tests.** The content-attribute counts printed by `pnpm sink` are the
  check; asserting them in CI is the obvious next step (QUESTIONS.md #6).
- **Streaming only.** `POST /chat` streams; there is no synchronous endpoint to
  compare against, so the trickiest lifecycle is the only one exercised.
- **No sampling.** Everything is exported (QUESTIONS.md #5).

## Provider configuration worth noting

The agent sets `providerOptions.openai.store = false`. Without it, the
Responses API refers to prior reasoning items by id, and a Zero Data Retention
organisation cannot resolve them — step 2 fails with *"Items are not persisted
for Zero Data Retention organizations"*. With `store: false` on a reasoning
model the provider automatically adds `include: ['reasoning.encrypted_content']`
and carries reasoning inline in the history instead.

Any multi-step agent on the Responses API under ZDR needs this.

## Versions

`ai@7.0.67` · `@ai-sdk/openai@4.0.42` · `hono@4.13.3` ·
`@microlabs/otel-cf-workers@1.0.0-rc.52` · `@opentelemetry/api@1.9.1` ·
`@opentelemetry/semantic-conventions@1.43.0` · `wrangler@4.124.0`

`nodejs_compat` is required: the OTel context manager needs
`AsyncLocalStorage` to keep spans parented across `await`.

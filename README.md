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

One request produces one trace, and each stream gets its own tree within it.
Abridged, from an actual run of `pnpm demo` against `gpt-5`:

```
── app stream          trace 93da21af…   10 spans, 0 content attributes
  fetchHandler POST 20ms
    invoke_agent math-assistant 7526ms
      · gen_ai.usage.total_tokens = 1638
      · agent.step.count = 3
      · gen_ai.outcome = success
      · facet.session_id = sess_42
      chat gpt-5 4930ms
        · gen_ai.usage.reasoning.output_tokens = 192
        · gen_ai.response.time_to_first_chunk = 4874
        · gen_ai.outcome = success
        · gen_ai.openai.ratelimit.remaining_tokens = 39999384
        · gen_ai.openai.ratelimit.reset_tokens = 0s
        fetch POST api.openai.com 345ms
      execute_tool calculator 1ms
        · gen_ai.tool.name = calculator
        · agent.tool.execution_ms = 0
      chat gpt-5 1709ms
      execute_tool calculator 0ms
      chat gpt-5 878ms

── trajectory stream   trace 93da21af…    9 spans, 19 content attributes
  invoke_agent gpt-5 7527ms
    ◆ gen_ai.input.messages = [{"role":"user","content":"What is 17% of 4320…
    ◆ gen_ai.system_instructions = "You are a careful arithmetic assistant…"
    step 1 4932ms
      chat gpt-5 4930ms
        ◆ gen_ai.input.messages = […]
        ◆ gen_ai.output.messages = [{"type":"tool-call","toolName":"calculator"…
      execute_tool calculator 1ms
        ◆ gen_ai.tool.call.arguments = {"operation":"multiply","a":4320,"b":0.17}
        ◆ gen_ai.tool.call.result = {"result":734.4000000000001}
    step 2 1710ms
    step 3 879ms
```

Same trace id, two trees. The application stream has every token count, finish
reason and timing and no message text at all. The trajectory stream has the
conversation, plus a `step` layer the application stream does not bother with,
and none of the transport spans — `fetchHandler` and the outbound `fetch` are
not part of a trajectory.

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

`gen_ai.tool.definitions` now comes from `@ai-sdk/otel` and carries the full
JSON Schema, identical on every model call of every request. For this sample —
a one-tool agent — that schema is larger than the whole chat history, three
times per request. A processor on the trajectory provider that rewrites the
attribute to tool *names* is about ten lines and worth having before this runs
at any volume.

### Two tracers, not one trace filtered twice

This is the load-bearing decision, and it is the one thing to look at if you
only read one file.

The two streams are written by **two different tracers backed by two different
providers**:

- the ambient tracer that `otel-cf-workers` installs — the request span, the
  outbound `fetch`, and everything `src/telemetry/app-telemetry.ts` writes
- a standalone `BasicTracerProvider` in `src/telemetry/trajectory.ts`, whose
  only processor ships to the evaluation backend

Both are handed to the AI SDK together:

```ts
telemetry: {
  recordInputs: true,
  recordOutputs: true,
  integrations: [
    appTelemetry(conversationId, facets),          // ours: no content, ever
    trajectory(env).integration(facets),           // @ai-sdk/otel, all content
  ],
}
```

`@ai-sdk/otel` is the AI SDK's official OpenTelemetry integration. Given a
`tracer`, it writes the whole trajectory — prompts, completions, tool
arguments, tool results, and a `step` span per model call — to spans that the
application stream's provider never sees, **because it never created them**.

That is what makes the boundary structural. There is no allowlist to keep
correct and no filter to misconfigure: the application stream contains exactly
what one file writes, and that file never reads a content field off an event.

Spans from both providers still parent off whatever is in the active context,
so they share a trace id and you can pivot between backends by it. Parenting
comes from context, not from the provider.

The cost, stated plainly: the agent portion of the trace exists **twice** — a
`chat` span on each stream, not one span seen two ways. Roughly double the span
volume for the agent, in exchange for a guarantee that does not depend on us.

An earlier revision of this repo did the other thing: one span per operation,
tagged with an audience, projected at the exporter. It worked, and it needed
~380 more lines. It also had a failure mode worth recording, because it is
invisible until you count attributes: when two integrations write to one span,
the creator must run before the writers and the closer after them. Collapsing
those roles silently drops every attribute the other integration meant to add —
the spans still appear, correctly shaped, just empty. Separate tracers make
that problem not exist rather than solving it.

### One thing needs model middleware

Rate-limit headroom arrives as response headers, and the telemetry lifecycle
events carry no headers. So `src/telemetry/rate-limits.ts` is a
`wrapLanguageModel` middleware — a second instrumentation path, for data that
arrives on the same HTTP response as the usage the hooks already give us.

It is worth the detour because it is the only forward-looking capacity number
a provider offers. Token counts say what a request cost; `remaining_tokens`
says how many more like it get served before throttling starts. On a 429 the
same middleware records `retry_after` off the error's response headers.

Rather than emit a span of its own, it stamps onto whichever span is active —
which during the provider call is the application stream's `chat` span, because
`app-telemetry.ts` puts it there via `executeLanguageModelCall`. A separate span
per model call to carry four numbers is a poor trade when the usage it would sit
next to is already on `chat`.

That the stamp lands on the *application* span rather than a trajectory one is
a consequence of which integration's `executeLanguageModelCall` wraps
innermost. Both ours and `@ai-sdk/otel`'s implement it. It resolves in our
favour, and it is verified rather than assumed — but it is not something we
control, which is QUESTIONS.md #13.

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
- **The trajectory root has a dangling parent.** Its `invoke_agent` span is a
  child of the request span, which only exists in the application stream, so an
  evaluation backend sees a parent id it was never sent. The fix is a processor
  on the trajectory provider that clears `parentSpanContext` on the elected
  root; left out here to keep the moving parts countable.
- **No tool-definition compaction** (see above).

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

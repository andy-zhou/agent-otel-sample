# Questions for the Cloudflare Workers team

The code in this repo is our best guess, not a proposal we are attached to.
These are the things we could not resolve from the outside. Roughly in order of
how much they would change the design.

---

### 1. Durable Object lifetime for a task no request is waiting on

We think we have solved this one and would like to be told whether we have.

Flushing on root-span end truncated traces badly when the agent ran in the
worker behind a streamed response: spans still open were exported with a forced
end time, and spans finishing after the last flush were dropped. Deferring the
flush and dangling it off the returned request with `ctx.waitUntil` fixed the
data but not the reasoning — we could not say how long the isolate would stay
alive or what happened to buffered spans if the budget ran out.

The turn now runs in a Durable Object via `void this.runTurn(params)`, output is
buffered and read back over a second request, and the flush is awaited at the
end of the turn. Verified: one complete batch per stream, correct durations,
nothing missing.

What we cannot see from outside:

- How long will a Durable Object keep running a promise that no request is
  awaiting? `startTurn` returns immediately and the turn may run for tens of
  seconds. Is fire-and-forget inside a DO a supported pattern, or are we
  relying on something incidental?
- What evicts it mid-turn, and is there a signal we can catch? Our span buffer
  and the turn's output are both in memory, so an eviction loses telemetry for
  the turn that most deserves it.
- Should the buffer be in DO storage, and is an alarm-driven flush the pattern
  you would reach for instead? The library already treats `do-alarm` as a
  traced trigger, which suggests yes.
- The worker and the DO are separate isolates and so hold separate span
  buffers. `wrangler dev` shares an isolate and hid a missing flush from us
  entirely. Is there a way to catch that class of mistake before production?

### 2. `recordInputs` / `recordOutputs` are not a per-integration filter

AI SDK v7 exposes `recordInputs` and `recordOutputs` on the telemetry options,
and each integration can read them off the event. But they are set per *call*,
not per integration — the events carry messages and tool output regardless, and
every registered integration sees them.

So a flag cannot separate the streams. What separates them here is that the two
integrations write to two different tracers, backed by two different providers:
content-bearing spans are never *constructed* by the provider that feeds the
operational backend. That is a structural guarantee rather than a filter we
maintain, and it is the main thing we would like sanity-checked.

- On Workers specifically, is running two `TracerProvider`s in one isolate
  sound? Two processors, two flush lifecycles, both draining under the same
  `waitUntil` budget.
- Is there any platform-level control that would make this unnecessary — a way
  to guarantee an exporter can never receive a given class of attribute
  regardless of application code?
- Anything wrong with a span in one trace being created by a tracer from a
  different provider than its parent? It works — both streams come out with the
  same trace id — but we would rather hear that it is intended than that it
  happens to work.

### 3. Trace context across a Durable Object boundary

We inject a W3C carrier into the RPC params in the worker and extract it in the
object, rather than relying on ambient propagation:

```ts
propagation.inject(context.active(), traceCarrier)                        // worker
const parent = propagation.extract(context.active(), params.traceCarrier) // object
```

It works — both `invoke_agent` roots come back parented to the request span.
But we chose it out of caution, not knowledge.

- Does trace context propagate into a DO **stub RPC call** on its own, making
  the carrier unnecessary?
- Does `instrumentDO` wrap RPC methods, or only `fetch`, `alarm` and the
  constructor? We see spans for the `fetch` read path but none for
  `startTurn`, which is why the carrier is load-bearing for us.
- Do DO alarms belong to the trace that scheduled them?

### 4. Span-processor state and the isolate boundary

The AI SDK offers `registerTelemetry(...integrations)` for global registration.
We build integrations per turn instead, because the open-span maps have to live
somewhere and module scope is shared by every concurrent request in an isolate.
The span processors themselves *are* module-level singletons, one per isolate.

Addressing the agent per conversation makes that mostly moot — a DO instance
handles one turn at a time — but it raised a sharper question. Because the
worker and the DO are separate isolates, they hold separate buffers, and we
briefly shipped a version where the worker's spans were never flushed at all.
It looked correct locally, because `wrangler dev` shares an isolate.

- Is per-isolate processor state the right model on Workers, or does something
  about the isolate lifecycle make it a trap?
- Is the local/production isolate-boundary difference documented somewhere we
  should have read? It is a silent, data-losing divergence.
- Is `AsyncLocalStorage` under `nodejs_compat` the supported way to carry OTel
  context, and does it hold across `waitUntil` and across a DO RPC boundary?

### 5. Sampling two streams at different rates

The streams have different economics. Operational spans are cheap and wanted in
aggregate. Trajectory spans are large — a long conversation is kilobytes of
JSON — and valuable in a curated subset, not in bulk.

We sample everything here, which will not survive production. What we want:
head-sample the application stream at some ratio, and independently select
trajectories (all errors, plus a slice of successes, plus anything a user
flagged). Since both derive from one trace, a head-sampling decision applies to
both.

Is tail sampling per stream something the platform can do, or does this belong
in a collector we run? `otel-cf-workers` has a `tailSampler`, but it decides
for the whole trace, not per stream.

### 6. Proving the application stream is clean

The guarantee is now that one file never reads a content field, and that the
provider feeding the operational backend never constructs a span that has one.
A verified run gives 0 content attributes on the application stream and 19 on
the trajectory stream — the number we would assert in CI.

That is much better than a filter, but it is still our code. We want something
enforced outside it, so that a mistake in this repo cannot put customer content
in an operational backend.

Is there a Workers-side enforcement point for that — an egress policy, a
binding that can only reach one endpoint, anything that makes the boundary
structural rather than conventional?

### 7. `@microlabs/otel-cf-workers` status

We are relying on `1.0.0-rc.52`, last published **May 2025** — 15 months ago as
of writing. It pins `@opentelemetry/otlp-exporter-base@^0.200.0` against a
current 0.221.x.

- Is this the path you would recommend, or is there a first-party direction we
  should take instead?
- If we used upstream `@opentelemetry/sdk-trace-base` directly, what breaks on
  Workers? Bundle size and the context manager are our two worries.
- Its auto-instrumented `fetch` span appears to end when the response begins,
  not when a streamed body has been consumed: for step 1 the `fetch` span
  reads 1144ms inside a `chat` span of 5091ms. Is that intended? For an
  SSE-heavy workload it makes the outbound span close to meaningless as a
  latency measure.
- Where does Workers Observability fit? Could it be the destination for the
  application stream, and if so does it accept OTLP directly?

### 8. Cost of instrumentation inside the CPU budget

Building spans, JSON-stringifying message arrays, and serialising OTLP all
happen on the request's CPU budget. A long trajectory means a large payload.

Is there a measurement approach you would suggest, and a point at which we
should move serialisation off the request path — a Tail Worker, a queue?

### 9. Errors that happen after the response has started

With an invalid API key this sample still returns HTTP 200: headers are already
sent when the provider call fails. The trace records the error; the HTTP status
does not.

Is there a convention for this on Workers, so that dashboards keyed on status
code do not report a broken request as a success?

### 10. Span naming and attribute conventions

We follow OTel GenAI semconv 1.43: `invoke_agent {name}`, `chat {model}`,
`execute_tool {name}`, with `gen_ai.*` attributes. Content goes on span
attributes rather than events, which the current semconv also does.

- Is that what your tooling expects to render?
- Anything you would name differently for the agent-specific spans, where
  semconv is still thin?

### 11. Span volume, now that the agent is traced twice

Two providers means the agent portion of the trace is emitted twice: a `chat`
span on the operational stream and another on the trajectory stream, plus a
`step` layer that only the trajectory stream carries. One request to this
sample produces 10 spans on one stream and 9 on the other.

An earlier revision kept one span per operation and projected it at the
exporter, which halved the volume but put the PII boundary in a filter (see
#2). We took the duplication deliberately.

- At production volume, is doubling agent spans the sort of thing that bites on
  Workers — CPU for serialisation, subrequest limits on export, cost?
- Would you expect the two streams to be sampled independently, and if so, does
  a head-sampling decision on the shared trace force the same answer on both?
  (Related: #5.)
- Is there a reason to prefer one provider with two exporters over two
  providers, on the platform rather than in principle?

### 12. Non-semconv attributes and a naming collision

We add `gen_ai.outcome`, `gen_ai.usage.total_tokens` and `error.*` because
semconv 1.43 has no equivalent. Two questions:

- Is squatting on the `gen_ai.*` namespace for attributes that are not in the
  spec a bad idea? A future semconv release could define `gen_ai.outcome` with
  different values than ours.
- Reasoning tokens are `gen_ai.usage.reasoning.output_tokens` in semconv 1.43,
  but at least one internal implementation writes
  `gen_ai.usage.reasoning_tokens`. Whichever is right, disagreeing about it
  silently splits a cost dashboard in half. Does your tooling key on the
  semconv name?

### 13. Rate-limit headers need a second instrumentation path

The most useful capacity signal a provider gives us is its rate-limit response
headers — `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`,
`retry-after` on a 429. The AI SDK's telemetry events carry no headers, so
`src/telemetry/rate-limits.ts` reaches them with `wrapLanguageModel` middleware
and stamps them onto the active span, which during the provider call is the
application stream's `chat` span.

It works — verified, real numbers on the right spans. Two things about it we
are not comfortable with:

- Which span the stamp lands on depends on whose
  `executeLanguageModelCall` wraps innermost, since both our integration and
  `@ai-sdk/otel` implement that hook. It currently resolves our way. Nothing in
  the contract says it must, and if it flipped, capacity data would silently
  move to the evaluation backend and vanish from the operational one. Is there
  a defined composition order, or should we not be relying on the active span
  at all?
- More broadly: every application on your platform calling a model provider
  needs these same six numbers, and each one is re-deriving them from headers
  with its own middleware. Is provider throttling something the platform could
  surface — on the outbound fetch span, say — rather than something each
  application reimplements?

And a Workers-specific one: is there any way to observe outbound *response*
headers from the platform side that we should prefer over model middleware?

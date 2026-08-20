# Questions for the Cloudflare Workers team

The code in this repo is our best guess, not a proposal we are attached to.
These are the things we could not resolve from the outside. Roughly in order of
how much they would change the design.

---

### 1. Span export when the response streams

We hit this for real, so this is less "how does it work" and more "is our
workaround the one you would recommend".

`POST /chat` returns at the first token. `otel-cf-workers` flushes a trace when
its root span ends — and the root span ends when the handler returns the
`Response`, not when the body finishes streaming. With the library's own
`BatchTraceSpanProcessor`, one request produced:

```
batch 1 [app] fetchHandler POST      start=+0ms    end=+2ms
batch 2 [app] invoke_agent           start=+2ms    end=+7ms     ← still running
              chat gpt-5             start=+3ms    end=+7ms     ← really ended +3988ms
...
batch 8 [app] execute_tool calculator
              (step 3's chat span and the final invoke_agent span never arrived)
```

Two failures. Spans still open at flush time were exported with a forced end
time and without the attributes written later, and spans that finished after
the last flush were dropped entirely. For an evaluation store a truncated
trajectory is worse than no trajectory.

Our fix is `src/telemetry/processor.ts`: ignore the library's flush, buffer
ended spans, and flush explicitly from the handler under `ctx.waitUntil`, keyed
on the promise that settles when the last step completes. That produces one
correct batch per stream.

- Is `waitUntil` the right primitive, or is there a hook for "the response body
  has finished streaming" that we should be using instead?
- How long will `waitUntil` really keep the isolate alive under load, and what
  happens to buffered spans when that budget runs out — dropped silently, or is
  there a signal we can catch and act on?
- Does an aborted client connection cut the flush short? A user closing the tab
  mid-answer is common, and we would still want the partial trajectory.
- Is flush-on-root-span-end simply the wrong default for streaming responses on
  Workers, and if so is that worth fixing upstream rather than in every app?

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

This sample is stateless to keep it small, but the real system puts session
state in a Durable Object.

- Does trace context propagate into a DO stub call automatically, or must we
  inject `traceparent` by hand?
- Should the DO export spans itself (`instrumentDO`), or hand them back to the
  calling Worker? Two isolates exporting into one trace raises clock-skew and
  ordering questions we would rather not discover in production.
- Do DO alarms belong to the trace that scheduled them?

### 4. Per-request vs. global integration registration

The SDK offers `registerTelemetry(...integrations)` for global registration.
We build integrations per request instead, because the open-span maps have to
live somewhere and module scope is shared by every concurrent request in an
isolate.

Is per-request construction the right instinct on Workers, or does the isolate
model make module-scope state safe here in a way it would not be in Node?
Related: is `AsyncLocalStorage` under `nodejs_compat` the supported way to
carry OTel context, and does it hold across `waitUntil`?

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

### 13. Provider rate-limit headers are not reachable from telemetry events

The most useful capacity signal a provider gives us is its rate-limit response
headers — `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`,
`retry-after` on a 429. Those are exactly what the application stream should
carry, and they are per-model-call.

The AI SDK's telemetry events do not expose response headers, so the only way
to capture them is to wrap the model with `wrapLanguageModel` middleware and
emit a span from there — a second, parallel instrumentation path alongside the
telemetry integrations, for data that arrives on the same HTTP response.

- Is there a Workers-side way to observe outbound response headers that we
  should prefer over model middleware?
- More generally: should provider throttling be a platform-level signal rather
  than something every application re-derives from headers?

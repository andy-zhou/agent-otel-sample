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

So the PII boundary in this repo is enforced entirely by our own code: the
`app` integration simply chooses not to read the content fields, and the
exporter drops any content attribute that reached a span anyway. Two layers,
both ours.

Is there a platform-level control we should be using instead — something that
prevents content from reaching a given exporter regardless of application code?
This is the part of the design we are least comfortable defending to a
reviewer, because "we promise not to read that field" is a code review away
from being false.

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

Right now the guarantee is an allowlist plus a code review. A verified run
gives 0 content attributes on the application stream and 16 on the trajectory
stream, which is the number we would assert in CI. Beyond that we want
something enforced outside our code, so that a mistake in this repo cannot put
customer content in an operational backend.

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

#!/usr/bin/env node
/**
 * Local OTLP/JSON receiver. Accepts both streams on separate paths and prints
 * each trace as a tree, so the difference between them is visible at a glance.
 *
 *   POST /app/v1/traces
 *   POST /trajectory/v1/traces
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 4318)
const CONTENT_ATTRS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
])

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const color = (stream, s) => (stream === 'app' ? `\x1b[36m${s}\x1b[0m` : `\x1b[35m${s}\x1b[0m`)

function attrValue(value) {
  if (!value || typeof value !== 'object') return String(value)
  const [kind, inner] = Object.entries(value)[0] ?? []
  if (kind === 'arrayValue') return `[${(inner.values ?? []).map(attrValue).join(', ')}]`
  return String(inner)
}

function flatten(payload) {
  const spans = []
  for (const resource of payload.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const attributes = {}
        for (const { key, value } of span.attributes ?? []) attributes[key] = attrValue(value)
        spans.push({
          name: span.name,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId || null,
          traceId: span.traceId,
          durationMs:
            (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6,
          attributes,
        })
      }
    }
  }
  return spans
}

function truncate(text, max = 120) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Spans for one trace arrive in several export batches — a streamed response
 * closes the request root long before the agent spans finish. Accumulate by
 * trace id so the tree assembles instead of showing false roots.
 */
const traces = new Map()

function printTree(stream, incoming) {
  const traceId = incoming[0]?.traceId ?? 'unknown'
  const key = `${stream}:${traceId}`
  const spans = [...(traces.get(key) ?? []), ...incoming]
  traces.set(key, spans)

  const contentCount = spans.reduce(
    (n, s) => n + Object.keys(s.attributes).filter((k) => CONTENT_ATTRS.has(k)).length,
    0,
  )

  console.log(
    `\n${color(stream, bold(`── ${stream} stream`))}  trace ${traceId}  ` +
      dim(
        `${spans.length} spans (+${incoming.length} this batch), ` +
          `${contentCount} content attributes`,
      ),
  )

  const byParent = new Map()
  for (const span of spans) {
    const key = span.parentSpanId ?? '__root__'
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(span)
  }
  const known = new Set(spans.map((s) => s.spanId))
  const roots = spans.filter((s) => !s.parentSpanId || !known.has(s.parentSpanId))

  const walk = (span, depth) => {
    const pad = '  '.repeat(depth)
    console.log(`${pad}${span.name} ${dim(`${span.durationMs.toFixed(0)}ms`)}`)
    for (const [key, value] of Object.entries(span.attributes)) {
      const marker = CONTENT_ATTRS.has(key) ? color('trajectory', '◆') : dim('·')
      console.log(`${pad}  ${marker} ${dim(key)} = ${truncate(value)}`)
    }
    for (const child of byParent.get(span.spanId) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 1)
}

createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const stream = req.url?.startsWith('/trajectory') ? 'trajectory' : 'app'
    try {
      const spans = flatten(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (spans.length > 0) printTree(stream, spans)
    } catch (error) {
      console.error(`could not parse ${stream} payload:`, error.message)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
}).listen(PORT, () => {
  console.log(`OTLP sink listening on http://localhost:${PORT}`)
  console.log(`  ${color('app', 'app')}        → POST /app/v1/traces`)
  console.log(`  ${color('trajectory', 'trajectory')} → POST /trajectory/v1/traces`)
  console.log(dim('◆ marks a content attribute — it should never appear in the app stream.\n'))
})

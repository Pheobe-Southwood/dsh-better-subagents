/* Enrichment of the native `list_subagent_models` result (tools/post-execute).
 *
 * The subject is `lib/post-execute.js`: the waterfall listener that appends an
 * authoritative model profile to a native `list_subagent_models` result, and
 * `install()`, which registers it on a plugin fiber.
 *
 * Everything here is offline by construction. The Artificial Analysis client
 * (`createAaClient`), the pi-ai catalogue reader (`readPiAiFacts`) and the clock
 * (`now`) are ALWAYS injected through `createEnricher`'s `deps` seam, so no test
 * can reach the network, read a snapshot from disk, or depend on the clock. The
 * real `authorizedRoutes` IS used, against a fake `sessionProjections` service,
 * so the authorization contract is exercised end to end rather than stubbed.
 *
 * The load-bearing promises this file pins, in the order they matter:
 *
 *   1. **Mode 1 (the PROVIDER list) is enriched.** The no-argument call is how
 *      an Agent enumerates its delegation routes; a bare provider line is
 *      resolved to advertised models first and then profiled. This was a real
 *      P0 bug that shipped silently because only modes 2 and 3 were exercised.
 *   2. **The native text survives byte-for-byte**, em dashes, descriptions and
 *      the whole `Reasoning efforts:` block included: the renderer reuses the
 *      native text verbatim and only appends after it.
 *   3. **A bare provider line is never annotated as unauthorized.** A provider
 *      can hold a mix of authorized and unauthorized models, so no per-route
 *      verdict may be attached to the provider line itself; only an explicit
 *      `<provider>/<model>` line outside the authorized set gets the suffix.
 *   4. **Every skip, failure and unknown-authorization path returns the exact
 *      decision `next()` produced** — a listener that throws turns a good tool
 *      result into an `isError` result, so the handler must never reject and the
 *      native content must never be rewritten on the way out.
 *   5. **The render is honest**: a genuine all-zero price is a `subscription
 *      route` (never `$0.00`, never "free"), an Artificial Analysis `null` is
 *      omitted (never printed as `0`), the attribution line is present whenever
 *      a profile is rendered, and a context window is labelled with the layer it
 *      really came from.
 *
 * All fixtures are synthetic. The three native outputs below are the shapes
 * captured verbatim from a live session in this deployment.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnricher, install, parseNativeResult } from '../lib/post-execute.js'
import { Config } from '../lib/index-config.js'

/* ------------------------------------------------------------------ */
/* the captured native wire format                                     */
/* ------------------------------------------------------------------ */

/** Exact native tool name this plugin intercepts. */
const NATIVE_TOOL = 'list_subagent_models'
const PROVIDER = 'qwen-token-plan-cn'
const MODEL = 'qwen3.8-flash'

/** The identity separator the native renderer emits: em dash U+2014, padded. */
const EM_DASH = '\u2014'
const SEPARATOR = ` ${EM_DASH} `

/** Suffix `lib/post-execute.js` appends to an explicit unauthorized model line. */
const UNAUTHORIZED_SUFFIX = `${SEPARATOR}not authorized for delegation in this Session`

/** Credit line `lib/catalog.js` appends to every rendered block. */
const ATTRIBUTION = 'Source: Artificial Analysis (artificialanalysis.ai)'

/**
 * Format 1 — `arguments: {}`, the PROVIDER list. This is the no-argument call
 * an Agent makes to enumerate its delegation routes, and the mode whose
 * enrichment once shipped broken.
 */
const PROVIDER_LIST_TEXT = `${PROVIDER}${SEPARATOR}${PROVIDER}`

/** Format 2 — `arguments: { provider }`, that provider's MODELS list. */
const MODELS_TEXT = `${PROVIDER}/${MODEL}${SEPARATOR}Qwen3.8 Flash`

/** Format 3 — `arguments: { provider, model }`, one model's DETAIL plus efforts. */
const DETAIL_TEXT = [
  `${PROVIDER}/${MODEL}${SEPARATOR}Qwen3.8 Flash`,
  'Reasoning efforts:',
  `low${SEPARATOR}Low`,
  `medium${SEPARATOR}Medium`,
  `xhigh${SEPARATOR}Xhigh`,
].join('\n')

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The Session object an `exec` carries; only its identity is ever used. */
const SESSION = { id: 'session-under-test' }

/** The route the fake Session policy authorizes. */
const AUTHORIZED = [{ provider: PROVIDER, model: MODEL }]

/**
 * Tiny injected lookup budget. No lookup here is slow, so the budget is never
 * consumed; it only keeps every `withDeadline` path bounded and the suite fast.
 */
const TIMEOUT_MS = 25

/** A distinctive failure text, so a leak into a tool result is unmissable. */
const SEAM_FAILURE = 'SEAM-EXPLODED-DO-NOT-LEAK'

/**
 * A fixed Artificial Analysis success envelope. Numbers are synthetic.
 *
 * `sourceOrigin` is present because real AA data always carries one, and its
 * presence is what turns an AA profile with NO speed measurement into the
 * honest `speed not measured` line instead of silence.
 */
const AA_PROFILE = Object.freeze({
  ok: true,
  sourceUrl: 'https://artificialanalysis.ai/models/test-model-a',
  fetchedAt: '2025-06-01T00:00:00.000Z',
  data: Object.freeze({
    rawName: 'Qwen3.8 Flash',
    slug: 'test-model-a',
    scores: 41.25,
    scoreName: 'Artificial Analysis Intelligence Index',
    scoreVersion: 'v4.3',
    rank: 12,
    ofCount: 100,
    pricePer1M: Object.freeze({ input: 0.15, output: 0.6, cacheRead: 0.05 }),
    contextWindow: 1_000_000,
    tokensPerSecond: 120.5,
    timeToFirstAnswerTokenSeconds: 12.5,
    sourceOrigin: 'aa-page',
  }),
})

/* ------------------------------------------------------------------ */
/* builders                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolved plugin config: the REAL defaults from `lib/index-config.js`, so
 * every test exercises a config-validated profile rather than a hand-built
 * object, with the lookup budget replaced by a tiny one.
 *
 * @param {object} [over] Top-level overrides.
 * @returns {object} resolved config.
 */
function testConfig(over = {}) {
  return Config({ timeoutMs: TIMEOUT_MS, ...over })
}

/**
 * A fake Cordis context.
 *
 * Services are reachable ONLY through `get(name)` — never as `ctx` properties,
 * which is the contract `safeService` implements — and the logger is inert
 * unless a test supplies its own sinks.
 *
 * @param {Record<string, any>} [services] service registry.
 * @param {object} [logger] logger sinks to record or override.
 * @returns {object} the fake context.
 */
function fakeCtx(services = {}, logger = {}) {
  return {
    get: (name) => services[name] ?? null,
    logger: { debug() {}, info() {}, error() {}, ...logger },
  }
}

/**
 * The authorization service, exactly as `lib/authorization.js` reads it:
 * `stateOf(session, 'subagentModelSelectionPolicy')`.
 *
 * @param {any} routes the state the projection reports.
 * @returns {{ service: object, calls: object[] }} the service and its call log.
 */
function sessionProjections(routes) {
  const calls = []
  return {
    calls,
    service: {
      stateOf: (session, key) => {
        calls.push({ session, key })
        return routes
      },
    },
  }
}

/**
 * A fake `llm` service: the harness's advertised-model catalogue and its runtime
 * model facts.
 *
 * @param {{ runtime?: any, onListModels?: Function, onResolveModelInfo?: Function }} [options]
 *   fixed runtime facts, or per-call hooks for the throwing/branching tests.
 * @returns {object} the fake service plus a `seen` call log.
 */
function fakeLlm(options = {}) {
  const seen = { listModels: [], resolveModelInfo: [] }
  return {
    seen,
    async listModels(provider) {
      seen.listModels.push(provider)
      if (typeof options.onListModels === 'function') return options.onListModels(provider)
      return [{ provider, id: MODEL, name: 'Qwen3.8 Flash' }]
    },
    async resolveModelInfo(provider, model, signal) {
      seen.resolveModelInfo.push({ provider, model, signal })
      if (typeof options.onResolveModelInfo === 'function') {
        return options.onResolveModelInfo(provider, model, signal)
      }
      return options.runtime ?? null
    },
  }
}

/**
 * A fake Artificial Analysis client. It answers from a fixed envelope and counts
 * its calls, so "exactly one lookup, no retry" is checkable.
 *
 * @param {any} [profile] fixed success envelope, or a `(provider, model) => envelope` hook.
 * @returns {{ client: object, calls: object[] }} the client and its call log.
 */
function fakeAa(profile = AA_PROFILE) {
  const calls = []
  return {
    calls,
    client: {
      async lookup(provider, model) {
        calls.push({ provider, model })
        return typeof profile === 'function' ? profile(provider, model) : profile
      },
      indexStatus: () => ({ loaded: false, tier: null, generatedAt: null, error: null }),
    },
  }
}

/**
 * One enricher plus every fake it can reach.
 *
 * `authorizedRoutes`, `llm` and the `tools` service are deliberately NOT
 * injected: the real implementations run against the fakes above.
 *
 * @param {{
 *   routes?: any, config?: object, services?: object, logger?: object, ctx?: object,
 *   llm?: object, llmOptions?: object, aaProfile?: any, deps?: object,
 * }} [options] overrides.
 * @returns {{ handler: Function, llm: object, aa: object, listed: object, services: object }} the harness.
 */
function harness(options = {}) {
  const routes = options.routes === undefined ? AUTHORIZED : options.routes
  const listed = sessionProjections(routes)
  const llm = options.llm ?? fakeLlm(options.llmOptions)
  const aa = fakeAa(options.aaProfile)
  const services = { sessionProjections: listed.service, llm, ...options.services }
  const deps = {
    createAaClient: () => aa.client,
    readPiAiFacts: async () => null,
    now: () => 0,
    ...options.deps,
  }
  const ctx = options.ctx ?? fakeCtx(services, options.logger)
  return { handler: createEnricher(ctx, testConfig(options.config), deps), llm, aa, listed, services }
}

/**
 * A native tool execution.
 *
 * @param {object} [over] overrides.
 * @returns {object} the execution.
 */
function nativeExec(over = {}) {
  return { name: NATIVE_TOOL, arguments: {}, agent: { session: SESSION }, signal: undefined, ...over }
}

/**
 * A native tool result.
 *
 * @param {string} text native result text.
 * @param {object} [over] overrides.
 * @returns {object} the result.
 */
function nativeResult(text, over = {}) {
  return { content: [{ type: 'text', text }], ...over }
}

/**
 * A `next()` that records its calls and returns one sentinel decision.
 *
 * The sentinel carries the ORIGINAL content array by reference, so decision
 * identity, content identity and the pre-call snapshot are all checkable.
 *
 * @param {object} result the tool result the waterfall was given.
 * @returns {{ sentinel: object, calls: any[], before: any, next: Function }} the recorder.
 */
function recordNext(result) {
  const before = structuredClone(result.content)
  const sentinel = { kind: 'accept', content: result.content }
  const calls = []
  return {
    before,
    sentinel,
    calls,
    next() {
      calls.push(1)
      return sentinel
    },
  }
}

/**
 * The text of a decision's content blocks, joined the way the native tool joins.
 *
 * @param {any} decision a post-execute decision.
 * @returns {string} the text.
 */
function contentText(decision) {
  return (decision?.content ?? [])
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Await a handler call inside an assertion that it FULFILLED.
 *
 * A rejecting `tools/post-execute` listener converts a good tool result into an
 * `isError` result, so "never rejects" is a product guarantee, not a nicety.
 *
 * @param {Promise<any>} promise the handler's return value.
 * @returns {Promise<any>} the resolved decision.
 */
async function fulfilled(promise) {
  assert.ok(promise !== null && typeof promise?.then === 'function', 'the handler must return a promise')
  const outcome = await promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  assert.equal(
    outcome.ok,
    true,
    `the handler must never reject, but rejected with: ${outcome.error?.message ?? String(outcome.error)}`,
  )
  return outcome.value
}

/**
 * Assert the whole pass-through contract for one scenario: the handler resolves,
 * returns the very decision `next()` produced, calls `next()` exactly once,
 * leaves the native content byte-for-byte untouched, and performs no lookup on
 * the way out.
 *
 * @param {{ name: string }} scenario scenario, forwarded to {@link harness}.
 * @returns {Promise<any>} the decision.
 */
async function assertPassthrough(scenario) {
  const h = harness(scenario)
  const recorded = recordNext(scenario.result)
  const decision = await fulfilled(h.handler(scenario.exec, scenario.result, recorded.next))
  assert.equal(decision, recorded.sentinel, 'the decision must be the one next() produced')
  assert.equal(recorded.calls.length, 1, 'next() must be called exactly once')
  assert.equal(decision.content, scenario.result.content, 'the content array must not be replaced')
  assert.deepEqual(scenario.result.content, recorded.before, 'the native content must not be rewritten')
  assert.equal(h.aa.calls.length, 0, 'no Artificial Analysis lookup may run on a pass-through')
  assert.equal(h.llm.seen.listModels.length, 0, 'no advertised-model lookup may run on a pass-through')
  assert.equal(h.llm.seen.resolveModelInfo.length, 0, 'no runtime fact read may run on a pass-through')
  return decision
}

/* ------------------------------------------------------------------ */
/* the fixtures are the captured native bytes                          */
/* ------------------------------------------------------------------ */

test('the captured native fixtures use the real em dash separator', () => {
  // Typed as a literal here on purpose: if this file ever normalized the
  // separator to a hyphen, every byte-for-byte assertion below would pass
  // against the wrong format.
  assert.ok(PROVIDER_LIST_TEXT.includes(' — '), 'the provider fixture uses U+2014')
  assert.ok(MODELS_TEXT.includes(' — '), 'the model fixture uses U+2014')
  assert.ok(DETAIL_TEXT.includes(' — '), 'the detail fixture uses U+2014')
  assert.ok(!PROVIDER_LIST_TEXT.includes(' - '), 'a hyphen separator is not the native format')
  assert.equal(SEPARATOR, ' — ')
  assert.equal(UNAUTHORIZED_SUFFIX, ' — not authorized for delegation in this Session')
  assert.equal(PROVIDER_LIST_TEXT, 'qwen-token-plan-cn — qwen-token-plan-cn')
  assert.equal(MODELS_TEXT, 'qwen-token-plan-cn/qwen3.8-flash — Qwen3.8 Flash')
  assert.equal(DETAIL_TEXT.split('\n')[1], 'Reasoning efforts:')
})

test('parseNativeResult names each of the three captured formats', () => {
  const providers = parseNativeResult(PROVIDER_LIST_TEXT)
  assert.equal(providers.mode, 'providers')
  assert.deepEqual(providers.providers, [{ provider: PROVIDER, name: PROVIDER }])

  // A SINGLE model line is also a valid bare detail — the native tool renders
  // exactly that text for `{ provider, model }` — so the parser reports the
  // detail shape. The handler never infers the mode from the text; it asks
  // `detectMode(exec.arguments)`, which is why mode 2 still works for a
  // one-line listing.
  const single = parseNativeResult(MODELS_TEXT)
  assert.equal(single.mode, 'model')

  const models = parseNativeResult(`${MODELS_TEXT}\n${PROVIDER}/qwen3.8-max${SEPARATOR}Qwen3.8 Max`)
  assert.equal(models.mode, 'models')
  assert.deepEqual(models.models, [
    { provider: PROVIDER, model: MODEL, name: 'Qwen3.8 Flash', description: null },
    { provider: PROVIDER, model: 'qwen3.8-max', name: 'Qwen3.8 Max', description: null },
  ])

  const detail = parseNativeResult(DETAIL_TEXT)
  assert.equal(detail.mode, 'model')
  assert.equal(detail.detail.provider, PROVIDER)
  assert.equal(detail.detail.model, MODEL)
  // Byte-for-byte: the reasoning block is a verbatim slice of the native text.
  assert.equal(detail.detail.reasoningSyntax, DETAIL_TEXT.slice(DETAIL_TEXT.indexOf('Reasoning efforts:')))

  assert.equal(parseNativeResult('(no LLM providers)').mode, 'unknown')
})

/* ------------------------------------------------------------------ */
/* the three native formats                                            */
/* ------------------------------------------------------------------ */

test('mode 1 — the no-argument PROVIDER list is enriched (regression)', async () => {
  const h = harness()
  const result = nativeResult(PROVIDER_LIST_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(h.handler(nativeExec({ arguments: {} }), result, recorded.next))

  // The P0 bug: this mode returned next() untouched, so an Agent enumerating its
  // routes saw no profiles at all.
  assert.notEqual(decision, recorded.sentinel, 'the provider listing MUST be enriched')
  assert.equal(decision.kind, 'accept')
  const text = contentText(decision)
  assert.ok(text.startsWith(`${PROVIDER_LIST_TEXT}\n\n`), 'the bare provider line stays verbatim and first')
  assert.ok(text.includes(`${PROVIDER}/${MODEL}${SEPARATOR}`), 'the resolved route is profiled')
  assert.ok(text.includes('score 41.3'), 'the AA score is rendered')
  assert.ok(text.includes(ATTRIBUTION), 'the attribution line is rendered')

  // The bare provider was resolved through the llm service and then looked up.
  assert.deepEqual(h.llm.seen.listModels, [PROVIDER])
  assert.deepEqual(h.aa.calls, [{ provider: PROVIDER, model: MODEL }], 'exactly one lookup, no retry')
  assert.ok(!text.includes(UNAUTHORIZED_SUFFIX), 'a bare provider line is never annotated')
})

test('mode 2 — the {provider} MODELS list profiles the authorized line', async () => {
  const h = harness()
  const result = nativeResult(MODELS_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recorded.next),
  )

  assert.notEqual(decision, recorded.sentinel, 'the model listing MUST be enriched')
  assert.equal(decision.kind, 'accept')
  const text = contentText(decision)
  assert.ok(text.startsWith(`${MODELS_TEXT}\n\n`), 'the native model line stays verbatim and first')
  assert.ok(text.includes('score 41.3 (Artificial Analysis Intelligence Index v4.3)'))
  assert.ok(text.includes('price in/out $0.15/$0.60 per 1M'), 'the compact layout prints in/out')
  assert.ok(text.includes('context 1,000,000 (AA, approximate)'))
  assert.ok(text.includes('speed 120.5 tok/s'))
  assert.ok(text.includes(ATTRIBUTION))
  assert.deepEqual(h.aa.calls, [{ provider: PROVIDER, model: MODEL }])
  assert.deepEqual(h.llm.seen.listModels, [], 'a {provider} call already names the provider')
})

test('mode 3 — the {provider, model} DETAIL block is enriched and re-emitted verbatim', async () => {
  const runtime = { contextWindow: 272_000, defaultMaxTokens: 32_768 }
  const h = harness({ llmOptions: { runtime } })
  const signal = { aborted: false }
  const result = nativeResult(DETAIL_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER, model: MODEL }, signal }), result, recorded.next),
  )

  assert.notEqual(decision, recorded.sentinel, 'the model detail MUST be enriched')
  const text = contentText(decision)
  assert.ok(text.startsWith(`${DETAIL_TEXT}\n\n`), 'the entire detail — reasoning block included — is reused verbatim')
  assert.ok(text.includes('Reasoning efforts:\nlow — Low\nmedium — Medium\nxhigh — Xhigh'))
  assert.ok(text.includes('score 41.3'))
  assert.ok(text.includes('rank 12 of 100'))
  assert.ok(text.includes('price in/out/cacheRead $0.15/$0.60/$0.05 per 1M'), 'the dossier prints all three rates')
  assert.ok(text.includes('context 272,000 tokens'), 'the runtime window is the operational limit')
  assert.ok(text.includes('max output 32,768'))
  assert.ok(text.includes(ATTRIBUTION))
  // The caller's signal is what bounds every lookup this handler performs.
  assert.deepEqual(h.llm.seen.resolveModelInfo, [{ provider: PROVIDER, model: MODEL, signal }])
})

test('the native text survives byte-for-byte in every mode', async () => {
  const cases = [
    { name: 'providers', exec: nativeExec({ arguments: {} }), native: PROVIDER_LIST_TEXT },
    { name: 'models', exec: nativeExec({ arguments: { provider: PROVIDER } }), native: MODELS_TEXT },
    {
      name: 'detail',
      exec: nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }),
      native: DETAIL_TEXT,
    },
  ]
  for (const scenario of cases) {
    const h = harness()
    const result = nativeResult(scenario.native)
    const decision = await fulfilled(h.handler(scenario.exec, result, recordNext(result).next))
    const text = contentText(decision)
    assert.ok(
      text.startsWith(`${scenario.native}\n\n`),
      `${scenario.name}: the native text must be a byte-for-byte prefix of the enriched content`,
    )
    // Exactly one blank line separates the native text from the appended block.
    assert.equal(text.indexOf(scenario.native), 0)
    assert.equal(text.slice(scenario.native.length, scenario.native.length + 2), '\n\n')
    // The preserved prefix is character-for-character the native text: no em
    // dash downgraded to a hyphen, no line re-joined, nothing trimmed.
    const preserved = text.slice(0, scenario.native.length)
    assert.equal(preserved, scenario.native, `${scenario.name}: every native character survives exactly`)
    assert.ok(!preserved.includes(' - '), `${scenario.name}: no separator was downgraded to a hyphen`)
  }
})

/* ------------------------------------------------------------------ */
/* authorization verdicts per line shape                               */
/* ------------------------------------------------------------------ */

test('authorization is read from the Session projection under its exact key', async () => {
  const h = harness()
  const result = nativeResult(MODELS_TEXT)
  await fulfilled(h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next))

  assert.equal(h.listed.calls.length, 1)
  assert.equal(h.listed.calls[0].session, SESSION, 'the Session comes from exec.agent.session')
  assert.equal(h.listed.calls[0].key, 'subagentModelSelectionPolicy')
})

test('an explicit provider/model line outside the authorized set keeps the suffix', async () => {
  const line = `${PROVIDER}/qwen3.9-ultra${SEPARATOR}Qwen3.9 Ultra`
  const h = harness()
  const result = nativeResult(line)
  const decision = await fulfilled(h.handler(nativeExec({ arguments: {} }), result, recordNext(result).next))

  // Nothing is enriched, and the only change to the native text is the verdict.
  assert.equal(contentText(decision), `${line}${UNAUTHORIZED_SUFFIX}`)
  assert.equal(h.aa.calls.length, 0, 'an unauthorized route is never looked up')
})

test('a mixed model list profiles the authorized line and marks only the other one', async () => {
  const other = `other-provider/qwen3.9-ultra${SEPARATOR}Qwen3.9 Ultra`
  const native = `${MODELS_TEXT}\n${other}`
  const h = harness()
  const result = nativeResult(native)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )

  const text = contentText(decision)
  assert.ok(
    text.startsWith(`${MODELS_TEXT}\n${other}${UNAUTHORIZED_SUFFIX}\n\n`),
    'both native lines survive verbatim; only the unauthorized one is annotated',
  )
  assert.ok(text.includes(`${PROVIDER}/${MODEL}${SEPARATOR}`), 'the authorized route is profiled')
  assert.deepEqual(h.aa.calls, [{ provider: PROVIDER, model: MODEL }], 'only the authorized route is looked up')
})

test('a bare provider line is never annotated, even when nothing it advertises is authorized', async () => {
  const native = `${PROVIDER_LIST_TEXT}\nother-provider${SEPARATOR}Other`
  const llm = fakeLlm({
    onListModels: (provider) =>
      provider === PROVIDER
        ? [{ provider, id: MODEL, name: 'Qwen3.8 Flash' }]
        : [{ provider, id: 'qwen3.9-ultra', name: 'Qwen3.9 Ultra' }],
  })
  const h = harness({ llm })
  const result = nativeResult(native)
  const decision = await fulfilled(h.handler(nativeExec({ arguments: {} }), result, recordNext(result).next))

  const text = contentText(decision)
  // A provider can hold a mix of authorized and unauthorized models, so no
  // per-route verdict may be attached to the provider line itself.
  assert.ok(text.startsWith(`${native}\n\n`), 'both provider lines stay byte-identical')
  assert.ok(!text.includes(UNAUTHORIZED_SUFFIX), 'no provider line carries a per-route verdict')
  assert.ok(text.includes(`${PROVIDER}/${MODEL}${SEPARATOR}`), 'the authorized route is still profiled')
  assert.equal(h.aa.calls.length, 1, 'the unauthorized provider contributes no lookup')
})

/* ------------------------------------------------------------------ */
/* resolving a bare provider's advertised models                       */
/* ------------------------------------------------------------------ */

test('a bare provider falls back to the Session’s own authorized routes', async () => {
  // No `llm` service and no `tools` service in this context: the only knowledge
  // left that names a route for this provider is the Session's own policy.
  const h = harness({ services: { llm: null } })
  const result = nativeResult(PROVIDER_LIST_TEXT)
  const decision = await fulfilled(h.handler(nativeExec({ arguments: {} }), result, recordNext(result).next))

  const text = contentText(decision)
  assert.ok(text.startsWith(`${PROVIDER_LIST_TEXT}\n\n`))
  assert.ok(text.includes(`${PROVIDER}/${MODEL}${SEPARATOR}`), 'the authorized route is still profiled')
  assert.ok(text.includes(ATTRIBUTION))
  assert.deepEqual(h.aa.calls, [{ provider: PROVIDER, model: MODEL }])
})

test('the native listing surface is used when no llm service advertises models', async () => {
  const calls = []
  const definition = {
    async execute(args, options) {
      calls.push({ args, options })
      return `${PROVIDER}/${MODEL}${SEPARATOR}Qwen3.8 Flash`
    },
  }
  const ctx = fakeCtx({
    sessionProjections: sessionProjections(AUTHORIZED).service,
    llm: null,
    tools: { get: (name) => (name === NATIVE_TOOL ? definition : null) },
  })
  const aa = fakeAa()
  const handler = createEnricher(ctx, testConfig(), {
    createAaClient: () => aa.client,
    readPiAiFacts: async () => null,
    now: () => 0,
  })
  const result = nativeResult(PROVIDER_LIST_TEXT)
  const decision = await fulfilled(handler(nativeExec({ arguments: {} }), result, recordNext(result).next))

  assert.ok(contentText(decision).includes(`${PROVIDER}/${MODEL}${SEPARATOR}`))
  assert.equal(calls.length, 1, 'exactly one resolution per distinct provider')
  assert.deepEqual(calls[0].args, { provider: PROVIDER })
  assert.equal(calls[0].options.signal, undefined)
})

test('the llm service is re-resolved when it mounts after the enricher', async () => {
  const services = { sessionProjections: sessionProjections(AUTHORIZED).service, llm: null }
  const aa = fakeAa()
  const handler = createEnricher(fakeCtx(services), testConfig(), {
    createAaClient: () => aa.client,
    readPiAiFacts: async () => null,
    now: () => 0,
  })
  // The native tool can mount before the llm service activates.
  services.llm = fakeLlm()
  const result = nativeResult(PROVIDER_LIST_TEXT)
  const decision = await fulfilled(handler(nativeExec({ arguments: {} }), result, recordNext(result).next))

  assert.ok(contentText(decision).includes(`${PROVIDER}/${MODEL}${SEPARATOR}`))
  assert.deepEqual(services.llm.seen.listModels, [PROVIDER])
})

/* ------------------------------------------------------------------ */
/* every pass-through path returns next() itself                       */
/* ------------------------------------------------------------------ */

const PASSTHROUGH_SCENARIOS = [
  {
    name: 'a failed tool result (result.isError === true)',
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: nativeResult(MODELS_TEXT, { isError: true }),
  },
  {
    name: 'config.enabled === false',
    config: { enabled: false },
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'a tool other than list_subagent_models',
    exec: nativeExec({ name: 'read_file', arguments: { provider: PROVIDER } }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'unparseable text',
    exec: nativeExec(),
    result: nativeResult('%%% this is not a native listing %%%'),
  },
  {
    name: 'empty text',
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: nativeResult(''),
  },
  {
    name: 'an empty content array',
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: { content: [] },
  },
  {
    name: 'a content array with no text block',
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: { content: [{ type: 'image', data: 'AAAA' }] },
  },
  {
    name: 'a non-array content value',
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: { content: MODELS_TEXT },
  },
  {
    name: 'arguments that are not JSON',
    exec: nativeExec({ arguments: 'not json' }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'authorization is unknown (no Session)',
    exec: nativeExec({ arguments: { provider: PROVIDER }, agent: undefined }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'authorization is known to be empty',
    routes: [],
    exec: nativeExec({ arguments: { provider: PROVIDER } }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'an already-aborted caller signal',
    exec: nativeExec({ arguments: { provider: PROVIDER }, signal: { aborted: true } }),
    result: nativeResult(MODELS_TEXT),
  },
  {
    name: 'an already-aborted caller signal on the provider list',
    exec: nativeExec({ arguments: {}, signal: { aborted: true } }),
    result: nativeResult(PROVIDER_LIST_TEXT),
  },
]

for (const scenario of PASSTHROUGH_SCENARIOS) {
  test(`pass-through: ${scenario.name}`, async () => {
    await assertPassthrough(scenario)
  })
}

test('the handler works with two arguments, where next() is optional', async () => {
  const h = harness()
  const result = nativeResult(MODELS_TEXT)
  const decision = await fulfilled(h.handler(nativeExec({ name: 'read_file' }), result))
  assert.deepEqual(decision, { kind: 'accept' })
})

/* ------------------------------------------------------------------ */
/* failure containment: the handler never throws and never rejects     */
/* ------------------------------------------------------------------ */

test('a throwing authorizedRoutes seam is contained and passes through', async () => {
  const h = harness({
    deps: {
      authorizedRoutes: async () => {
        throw new Error(SEAM_FAILURE)
      },
    },
  })
  const result = nativeResult(MODELS_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recorded.next),
  )

  assert.equal(decision, recorded.sentinel, 'unknown authorization must never be presented as authorized')
  assert.deepEqual(result.content, recorded.before)
  assert.equal(h.aa.calls.length, 0)
})

test('a throwing readPiAiFacts seam is contained by the settled lookups', async () => {
  const h = harness({
    deps: {
      readPiAiFacts: async () => {
        throw new Error(SEAM_FAILURE)
      },
    },
  })
  const result = nativeResult(MODELS_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )

  assert.equal(decision.kind, 'accept', 'the remaining layers still answer')
  const text = contentText(decision)
  assert.ok(text.startsWith(`${MODELS_TEXT}\n\n`), 'the native text survives verbatim')
  assert.ok(text.includes('score 41.3'), 'the AA layer still renders')
  assert.ok(!text.includes(SEAM_FAILURE), 'a seam failure must never reach the model')
  assert.ok(!text.includes('Error'), 'no error text may be rendered into the result')
})

test('a throwing createAaClient seam is contained, logged and never leaked', async () => {
  const lines = []
  const h = harness({
    config: { debugLog: true },
    logger: { debug: (line) => lines.push(String(line)) },
    deps: {
      createAaClient: () => {
        throw new Error(SEAM_FAILURE)
      },
    },
  })
  const result = nativeResult(MODELS_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )

  assert.equal(decision.kind, 'accept')
  const text = contentText(decision)
  assert.ok(text.startsWith(`${MODELS_TEXT}\n\n`), 'the native text survives verbatim')
  assert.ok(!text.includes(SEAM_FAILURE), 'a seam failure must never reach the model')
  assert.ok(!text.includes('$'), 'with no reachable price layer, no rate is invented')
  assert.ok(
    lines.some((line) => line.includes(SEAM_FAILURE)),
    'the operator still sees the failure on the debug channel',
  )
})

test('a throwing llm.resolveModelInfo is contained and the context falls back honestly', async () => {
  const h = harness({
    llm: fakeLlm({
      onResolveModelInfo: () => {
        throw new Error(SEAM_FAILURE)
      },
    }),
  })
  const result = nativeResult(MODELS_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )

  const text = contentText(decision)
  assert.ok(text.startsWith(`${MODELS_TEXT}\n\n`))
  assert.ok(
    text.includes('context 1,000,000 (AA, approximate)'),
    'an unreachable runtime downgrades the context to the labelled AA figure',
  )
  assert.ok(!text.includes(SEAM_FAILURE), 'a seam failure must never reach the model')
})

test('a throwing llm.listModels is contained and resolves no model at all', async () => {
  const h = harness({
    llm: fakeLlm({
      onListModels: () => {
        throw new Error(SEAM_FAILURE)
      },
    }),
  })
  const result = nativeResult(PROVIDER_LIST_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(h.handler(nativeExec({ arguments: {} }), result, recorded.next))

  // A reachable source that failed is an answer of "nothing": the native
  // provider line is returned untouched rather than enriched with a guess.
  assert.equal(decision, recorded.sentinel)
  assert.equal(h.aa.calls.length, 0)
})

test('the handler never rejects, even for hostile inputs', async () => {
  const hostile = [
    {
      name: 'a service registry that throws on every read',
      ctx: {
        get: () => {
          throw new Error(SEAM_FAILURE)
        },
        logger: {},
      },
      exec: nativeExec({ arguments: { provider: PROVIDER } }),
      result: nativeResult(MODELS_TEXT),
    },
    {
      name: 'an agent whose session getter throws',
      exec: nativeExec({
        arguments: { provider: PROVIDER },
        agent: {
          get session() {
            throw new Error(SEAM_FAILURE)
          },
        },
      }),
      result: nativeResult(MODELS_TEXT),
    },
    {
      name: 'arguments that throw on every property read',
      exec: nativeExec({
        arguments: new Proxy({}, {
          get() {
            throw new Error(SEAM_FAILURE)
          },
        }),
      }),
      result: nativeResult(MODELS_TEXT),
    },
    {
      name: 'content whose iterator throws',
      exec: nativeExec({ arguments: { provider: PROVIDER } }),
      result: {
        content: new Proxy([], {
          get() {
            throw new Error(SEAM_FAILURE)
          },
        }),
      },
    },
    {
      name: 'a primitive result',
      exec: nativeExec({ arguments: {} }),
      result: 42,
    },
  ]

  for (const scenario of hostile) {
    const h = harness({ ctx: scenario.ctx })
    const decision = await fulfilled(h.handler(scenario.exec, scenario.result, () => ({ kind: 'accept' })))
    assert.ok(decision !== null && typeof decision === 'object', `${scenario.name}: a decision must be returned`)
    assert.equal(decision.kind, 'accept', `${scenario.name}: the waterfall contract is preserved`)
  }
})

/* ------------------------------------------------------------------ */
/* honesty in the render                                               */
/* ------------------------------------------------------------------ */

test('a genuine all-zero price is a subscription route, never $0.00 or "free"', async () => {
  const zero = {
    ...AA_PROFILE,
    data: { ...AA_PROFILE.data, pricePer1M: { input: 0, output: 0, cacheRead: 0 } },
  }
  const detail = harness({ aaProfile: zero })
  const detailResult = nativeResult(DETAIL_TEXT)
  const detailDecision = await fulfilled(
    detail.handler(
      nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }),
      detailResult,
      recordNext(detailResult).next,
    ),
  )
  const dossier = contentText(detailDecision)
  assert.ok(dossier.includes('price in/out/cacheRead per 1M: subscription route (catalogue rate 0)'))
  assert.ok(!dossier.includes('$0.00'), 'a zero rate is never printed as a price')
  assert.ok(!/free/i.test(dossier), 'a zero rate is never called free')

  const list = harness({ aaProfile: zero })
  const listResult = nativeResult(MODELS_TEXT)
  const listDecision = await fulfilled(
    list.handler(
      nativeExec({ arguments: { provider: PROVIDER } }),
      listResult,
      recordNext(listResult).next,
    ),
  )
  const compact = contentText(listDecision)
  assert.ok(compact.includes('price in/out per 1M: subscription route (catalogue rate 0)'))
  assert.ok(!compact.includes('$0.00'))
  assert.ok(!/free/i.test(compact))
})

test('an Artificial Analysis null is omitted, never printed as 0', async () => {
  const sparse = {
    ...AA_PROFILE,
    data: {
      ...AA_PROFILE.data,
      tokensPerSecond: null,
      timeToFirstAnswerTokenSeconds: null,
      rank: null,
      ofCount: null,
      contextWindow: null,
    },
  }
  const h = harness({ aaProfile: sparse })
  const result = nativeResult(DETAIL_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }), result, recordNext(result).next),
  )
  const text = contentText(decision)

  assert.ok(text.includes('score 41.3'), 'the facts AA did publish still render')
  assert.ok(text.includes('speed not measured'), 'a missing measurement is stated, not invented')
  assert.ok(!text.includes('tok/s'), 'no speed is invented')
  assert.ok(!text.includes('0.00s'), 'no latency is invented')
  assert.ok(!text.includes('rank'), 'no rank is invented')
  assert.ok(!text.includes('context 0'), 'an unknown context window is omitted')
  assert.ok(!/\bnull\b/.test(text), 'no layer name or null sentinel leaks into the render')
  assert.ok(!text.includes('undefined'))
})

test('the attribution line is present whenever a profile is rendered', async () => {
  const cases = [
    { exec: nativeExec({ arguments: {} }), native: PROVIDER_LIST_TEXT },
    { exec: nativeExec({ arguments: { provider: PROVIDER } }), native: MODELS_TEXT },
    { exec: nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }), native: DETAIL_TEXT },
  ]
  for (const scenario of cases) {
    const h = harness()
    const result = nativeResult(scenario.native)
    const decision = await fulfilled(h.handler(scenario.exec, result, recordNext(result).next))
    assert.ok(contentText(decision).includes(ATTRIBUTION), `missing attribution for: ${scenario.native}`)
  }
})

test('the attribution line is omitted when the config turns it off', async () => {
  const h = harness({ config: { includeAttribution: false } })
  const result = nativeResult(MODELS_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )
  const text = contentText(decision)
  assert.ok(text.startsWith(`${MODELS_TEXT}\n\n`))
  assert.ok(text.includes('score 41.3'))
  assert.ok(!text.includes('Source: Artificial Analysis'))
})

test('the runtime context window outranks the AA and catalogue values', async () => {
  const h = harness({
    llmOptions: { runtime: { contextWindow: 272_000, defaultMaxTokens: 32_768 } },
    deps: {
      readPiAiFacts: async () => ({ cost: { input: 1, output: 2 }, contextWindow: 1_000_000, maxTokens: 65_536 }),
    },
  })
  const result = nativeResult(DETAIL_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }), result, recordNext(result).next),
  )
  const text = contentText(decision)

  assert.ok(text.includes('context 272,000 tokens'), 'the adapter’s enforced window wins')
  assert.ok(!text.includes('1,000,000'), 'neither the AA nor the catalogue figure is printed')
  assert.ok(!text.includes('(AA, approximate)'))
  assert.ok(!text.includes('catalogue'))
})

test('a context window known only from the catalogue is labelled as a catalogue value', async () => {
  const h = harness({
    aaProfile: { ok: false, reason: 'not-on-aa', detail: 'no page matched' },
    deps: {
      readPiAiFacts: async () => ({ cost: { input: 1, output: 2 }, contextWindow: 1_000_000, maxTokens: 65_536 }),
    },
  })
  const result = nativeResult(DETAIL_TEXT)
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER, model: MODEL } }), result, recordNext(result).next),
  )
  const text = contentText(decision)

  assert.ok(text.includes('context 1,000,000 tokens (pi-ai catalogue)'), 'the catalogue is named, not implied')
  assert.ok(text.includes('max output 65,536'))
  assert.ok(text.includes('price in/out $1.00/$2.00 per 1M'))
  assert.ok(text.includes('not available: no Artificial Analysis profile found'))
  assert.ok(text.includes(ATTRIBUTION))
})

test('enrichment keeps non-text content blocks in place', async () => {
  const image = { type: 'image', data: 'AAAA' }
  const h = harness()
  const result = { content: [{ type: 'text', text: MODELS_TEXT }, image] }
  const decision = await fulfilled(
    h.handler(nativeExec({ arguments: { provider: PROVIDER } }), result, recordNext(result).next),
  )

  assert.equal(decision.content.length, 2)
  assert.equal(decision.content[0].type, 'text')
  assert.ok(decision.content[0].text.startsWith(`${MODELS_TEXT}\n\n`))
  assert.equal(decision.content[1], image, 'a non-text block is preserved by reference')
})

/* ------------------------------------------------------------------ */
/* install(ctx, config)                                                */
/* ------------------------------------------------------------------ */

test('install registers exactly one listener synchronously and resolves to a disposer', async () => {
  const registrations = []
  const ctx = { on: (name, listener) => registrations.push({ name, listener }), logger: {} }
  const pending = install(ctx, testConfig())

  // Synchronous registration: the listener must belong to the plugin fiber from
  // the first tick, not after an asynchronous load step.
  assert.equal(registrations.length, 1, 'the listener must be registered before any await')
  assert.equal(registrations[0].name, 'tools/post-execute')
  assert.equal(typeof registrations[0].listener, 'function')
  assert.equal(typeof pending.then, 'function', 'install returns a promise')

  const installed = await fulfilled(pending)
  assert.equal(typeof installed.dispose, 'function')
  assert.doesNotThrow(() => installed.dispose())

  // The registered listener is wired to the enricher: a non-native tool passes
  // straight through, so nothing here can reach the network.
  const result = nativeResult(MODELS_TEXT)
  const recorded = recordNext(result)
  const decision = await fulfilled(
    registrations[0].listener(nativeExec({ name: 'read_file' }), result, recorded.next),
  )
  assert.equal(decision, recorded.sentinel)
})

test('a ctx.on that throws degrades to no enrichment instead of failing the boot', async () => {
  const errors = []
  const ctx = {
    on: () => {
      throw new Error('the registry refuses listeners')
    },
    logger: { error: (line) => errors.push(String(line)) },
  }
  const installed = await fulfilled(install(ctx, testConfig()))

  assert.equal(typeof installed.dispose, 'function')
  assert.equal(errors.length, 1, 'the failure is reported exactly once')
  assert.ok(errors[0].includes('tools/post-execute'), 'and it names what could not be registered')
  assert.doesNotThrow(() => installed.dispose())
})

test('install resolves even when the context has no listener registry or a throwing logger', async () => {
  const withoutOn = await fulfilled(install({}, testConfig()))
  assert.equal(typeof withoutOn.dispose, 'function')

  const hostile = await fulfilled(
    install(
      {
        on: () => {
          throw new Error('no')
        },
        logger: {
          error: () => {
            throw new Error('the log sink is down too')
          },
        },
      },
      testConfig(),
    ),
  )
  assert.equal(typeof hostile.dispose, 'function')
})

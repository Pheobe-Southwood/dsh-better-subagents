/* The Artificial Analysis lookup client: routes, cache, deadline, credentials.
 *
 * Everything here runs through `installAaFetcherForTests`, so the suite is
 * fully offline: the installed fetcher is the ONLY way a request can leave
 * `lib/aa/client.js`, and every fake counts its calls. The load-bearing
 * promises this file pins:
 *
 *   1. nothing is ever retried — a failure is remembered (the index for its own
 *      error TTL, a lookup for `failureTtlMs`), because the Free index allows
 *      100 requests / 24 h and a retry loop would burn the quota;
 *   2. every failure is a RESULT, never a rejection, and never slower than the
 *      configured budget;
 *   3. a credential value is written to one header on one route and appears
 *      nowhere else — not in a result, not in a log, not in a URL;
 *   4. `config.timeoutMs: 0` means "no network" without meaning "no data": a
 *      local snapshot is still served.
 *
 * All fixtures are synthetic (`Test-Model-A`, score 41.25): no Artificial
 * Analysis page content is redistributed here.
 */
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAaClient, installAaFetcherForTests, resetAaCacheForTests } from '../lib/aa/client.js'
import { Config } from '../lib/index-config.js'

/** The one origin and the two paths the client may ever request. */
const ORIGIN = 'https://artificialanalysis.ai'
const INDEX_URL = `${ORIGIN}/api/v2/language/models/free`
/** The only other path prefix the client may request. */
const PAGE_PREFIX = `${ORIGIN}/models/`
const MODEL = 'Test-Model-A'
const SLUG = 'test-model-a'
const GENERATED_AT = '2025-06-01T00:00:00.000Z'

/**
 * The budget for every test that is NOT about the deadline. It is deliberately
 * far above any stub's latency rather than as small as possible: `node --test`
 * runs test files in parallel, and a 50 ms budget expires under load in tests
 * whose subject is the cache or a route, not the clock. A budget that is never
 * consumed costs nothing, so the suite stays fast either way; the tests that do
 * measure timing inject 10-25 ms instead.
 */
const NO_TIMEOUT_MS = 2_000

/** A distinctive value, so any leak into a result or a log is unmissable. */
const KEY = 'TESTKEY-DO-NOT-LEAK-12345'
const ENV_KEY = 'ENVKEY-DO-NOT-LEAK-67890'

/** Filesystem state shared by the whole file (the tests run sequentially). */
let workDir
let snapshotSeq = 0
let savedEnvKey

beforeEach(async () => {
  // The index, the snapshot and every lookup cache are module-global.
  resetAaCacheForTests()
  workDir = await mkdtemp(join(tmpdir(), 'dsh-aa-client-'))
  savedEnvKey = process.env.AA_API_KEY
  delete process.env.AA_API_KEY
})

afterEach(async () => {
  installAaFetcherForTests(null)
  if (savedEnvKey === undefined) delete process.env.AA_API_KEY
  else process.env.AA_API_KEY = savedEnvKey
  await rm(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* fixtures and stubs                                                  */
/* ------------------------------------------------------------------ */

/** A snapshot path that cannot exist, so no local file can answer. */
function missingSnapshot() {
  return join(workDir, 'no-such-snapshot.json')
}

/**
 * Resolved plugin config: real defaults from `lib/index-config.js`, so these
 * tests exercise a config-validated profile rather than a hand-built object.
 *
 * @param {object} [over] Top-level overrides.
 * @param {object} [aa] `aa` overrides; the snapshot path defaults to "absent".
 * @returns {object} Config.
 */
function config(over = {}, aa = {}) {
  return Config({ ...over, aa: { snapshotPath: missingSnapshot(), ...aa } })
}

/** A `Response`-shaped stub carrying JSON. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** A `Response`-shaped stub carrying HTML. */
function htmlResponse(html, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => {
      throw new Error('not JSON')
    },
    text: async () => html,
  }
}

/**
 * A counting fetcher. Every request is recorded, and the defaults (index 401,
 * page 404) never touch the network, so an unplanned request shows up as an
 * exact call count rather than as a live connection.
 *
 * @param {{ index?: Function, page?: Function }} [handlers] Per-route answers.
 * @returns {object} Fetcher plus call-recording helpers.
 */
function countingFetch(handlers = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) }
    calls.push({ url, init, headers })
    const isIndex = url.startsWith(INDEX_URL)
    const handler = isIndex ? handlers.index : handlers.page
    if (typeof handler === 'function') return handler(url, init, calls.filter((call) => call.url === url).length)
    return isIndex ? jsonResponse({}, { status: 401 }) : htmlResponse('<html></html>', { status: 404 })
  }
  return {
    fetchImpl,
    calls,
    count: () => calls.length,
    urls: () => calls.map((call) => call.url),
    indexCalls: () => calls.filter((call) => call.url.startsWith(INDEX_URL)),
    // `/api/v2/language/models/free` also contains `/models/`, so the page
    // filter anchors on the origin-relative page prefix instead.
    pageCalls: () => calls.filter((call) => call.url.startsWith(PAGE_PREFIX)),
  }
}

/**
 * A fetcher that must never be reached: it records the attempt, then throws.
 *
 * {@link countingFetch} records an unplanned request for a later assertion;
 * this one refuses on the spot, so an offline lookup that reaches the network
 * even once cannot pass by happening to survive the attempt.
 *
 * @returns {object} Fetcher plus call-recording helpers.
 */
function throwingFetch() {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    throw new Error(`the network is off, so no request may leave the client (attempted ${url})`)
  }
  return { fetchImpl, calls, count: () => calls.length, urls: () => [...calls] }
}

/**
 * A stand-in Cordis context: `get('credentials')` answers with the harness
 * credential service shape, and `logger.info` collects the debug lines.
 *
 * @param {object} [options] Context options.
 * @returns {object} Fake context with a `logs` array.
 */
function fakeCtx({ credentials } = {}) {
  const logs = []
  return {
    logs,
    get: (name) => (name === 'credentials' ? credentials : undefined),
    logger: { info: (message) => logs.push(String(message)) },
  }
}

/**
 * A credential service whose resolved value is `value`, counting its calls.
 *
 * @param {string} value Credential value.
 * @returns {object} Credential service stub.
 */
function credentialService(value) {
  const calls = { describe: 0, resolve: 0 }
  return {
    calls,
    describe: async () => {
      calls.describe += 1
      return { configured: true }
    },
    resolve: async () => {
      calls.resolve += 1
      return { value }
    },
  }
}

/** One Free-index row, in the documented raw API shape. */
const RAW_INDEX_ROW = {
  id: 'tm-a',
  name: MODEL,
  slug: SLUG,
  release_date: '2025-05-01',
  model_creator: { id: 'fx', name: 'Fixture Labs', slug: 'fixture-labs' },
  evaluations: { artificial_analysis_intelligence_index: 41.25 },
  pricing: { price_1m_input_tokens: 0.15, price_1m_output_tokens: 0.6, price_1m_cache_hit_tokens: 0.05 },
  performance: { median_output_tokens_per_second: 88.5, median_time_to_first_answer_token_seconds: 0.42 },
  context_window_tokens: 131072,
}

/** A one-page index envelope carrying {@link RAW_INDEX_ROW}. */
const INDEX_ENVELOPE = {
  tier: 'free',
  intelligence_index_version: 'v9.9',
  generated_at: GENERATED_AT,
  pagination: { page: 1, page_size: 25, total_pages: 1, has_more: false },
  data: [RAW_INDEX_ROW],
}

/** One normalized snapshot entry, as `parseAaFreeIndex` produces it. */
const SNAPSHOT_ENTRY = {
  id: 'tm-a',
  name: MODEL,
  slug: SLUG,
  modelCreator: 'Fixture Labs',
  scores: 41.25,
  scoreName: 'Artificial Analysis Intelligence Index',
  tokensPerSecond: 88.5,
  timeToFirstAnswerTokenSeconds: 0.42,
  pricePer1M: { input: 0.15, output: 0.6, cacheRead: 0.05 },
  contextWindow: 131072,
  generatedAt: null,
}

/**
 * Write a snapshot in exactly the shape `bin/sync-aa.mjs` produces.
 *
 * @param {object[]} [entries] Snapshot entries.
 * @param {object} [over] Envelope overrides.
 * @returns {Promise<string>} Snapshot path.
 */
async function writeSnapshot(entries = [SNAPSHOT_ENTRY], over = {}) {
  snapshotSeq += 1
  const path = join(workDir, `aa-snapshot-${snapshotSeq}.json`)
  await writeFile(
    path,
    `${JSON.stringify(
      {
        generatedAt: GENERATED_AT,
        source: INDEX_URL,
        attribution: 'Source: Artificial Analysis (artificialanalysis.ai)',
        intelligenceIndexVersion: 'v9.9',
        entries,
        ...over,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return path
}

/**
 * A synthetic model page: only the structure `parseAaModelPage` reads.
 *
 * @param {{ slug?: string, latency?: boolean, score?: number }} [options] Page options.
 * @returns {string} Page HTML.
 */
function modelPageHtml({ slug = SLUG, latency = false, score = 41.25 } = {}) {
  const blocks = [
    {
      '@type': 'Dataset',
      name: 'Artificial Analysis Intelligence Index',
      description: 'Artificial Analysis Intelligence Index v9.9 incorporates 10 evaluations: synthetic fixture text.',
      data: [{ label: MODEL, detailsUrl: `/models/${slug}`, intelligenceIndex: score, medianOutputTokensPerSecond: 88.5 }],
    },
  ]
  if (latency) {
    blocks.push({
      '@type': 'Dataset',
      name: 'Latency: Time To First Answer Token',
      data: [{ label: MODEL, detailsUrl: `/models/${slug}`, inputTime: 0.42, reasoningTime: 12.5 }],
    })
  }
  return [
    '<!doctype html><html><head>',
    `<link rel="canonical" href="https://artificialanalysis.ai/models/${slug}">`,
    `<meta property="og:title" content="${MODEL} | Artificial Analysis">`,
    '</head><body>',
    blocks.map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join(''),
    '</body></html>',
  ].join('')
}

/** The two slugs `aaSlugCandidates('Test-Model-A')` proposes, in order. */
const PAGE_URLS = [`${PAGE_PREFIX}${SLUG}`, `${PAGE_PREFIX}${SLUG}-next`]

/** Sleep, for the one place a TTL must actually elapse. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Warm `client`'s snapshot cache.
 *
 * A lookup reads the snapshot file before it requests anything, and a deadline
 * armed at the start of the lookup would race that read: under `node --test`'s
 * parallel load an ENOENT read can outlast a 25 ms budget, and the lookup would
 * then time out before its first request ever went out. One throwaway lookup
 * with an instant stub populates the cache, so the timed lookup below reaches
 * its request with no I/O in the way.
 *
 * @param {object} client Client whose snapshot path should be warmed.
 * @returns {Promise<void>} Resolves once the cache is warm.
 */
async function warmSnapshot(client) {
  const warm = countingFetch()
  installAaFetcherForTests(warm.fetchImpl)
  await client.lookup('warmup-provider', MODEL)
}

/**
 * Wait until `predicate` holds, or fail after a generous bound. Used instead of
 * a fixed sleep wherever the thing being waited for follows a filesystem probe.
 *
 * @param {() => boolean} predicate Condition to await.
 * @param {number} [budgetMs] Upper bound.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
async function waitFor(predicate, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await delay(1)
  }
}

/* ------------------------------------------------------------------ */
/* the master switch                                                   */
/* ------------------------------------------------------------------ */

test('config.aa.enabled false answers disabled and spends no request at all', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = credentialService(KEY)
  const ctx = fakeCtx({ credentials })
  const client = createAaClient({ config: config({}, { enabled: false }), ctx })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'disabled')
  assert.equal(typeof result.detail, 'string')
  assert.equal(fake.count(), 0, 'a disabled lookup must not even resolve the credential')
  assert.equal(credentials.calls.resolve, 0)
  assert.equal(credentials.calls.describe, 0)
  assert.deepEqual(client.indexStatus(), { loaded: false, tier: null, generatedAt: null, error: null })
})

/* ------------------------------------------------------------------ */
/* timeoutMs: 0 — no network, local sources only                        */
/* ------------------------------------------------------------------ */

test('timeoutMs 0 spends no request and still serves a configured snapshot', async () => {
  const snapshotPath = await writeSnapshot()
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = credentialService(KEY)
  const client = createAaClient({ config: config({ timeoutMs: 0 }, { snapshotPath }), ctx: fakeCtx({ credentials }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.via, 'exact')
  assert.equal(result.data.sourceOrigin, 'aa-snapshot')
  assert.equal(result.data.model, MODEL)
  assert.equal(result.data.rawName, MODEL)
  assert.equal(result.data.scores, 41.25)
  assert.equal(result.data.scoreName, 'Artificial Analysis Intelligence Index')
  assert.equal(result.data.scoreVersion, 'v9.9')
  assert.equal(result.data.tokensPerSecond, 88.5)
  assert.equal(result.data.timeToFirstAnswerTokenSeconds, 0.42)
  assert.equal(result.data.contextWindow, 131072)
  assert.deepEqual(result.data.pricePer1M, { input: 0.15, output: 0.6, cacheRead: 0.05 })
  assert.equal(result.data.generatedAt, GENERATED_AT)
  assert.equal(result.sourceUrl, INDEX_URL)

  assert.equal(fake.count(), 0, 'timeoutMs 0 must not open a connection')
  assert.equal(credentials.calls.resolve, 0, 'the key is not even read when the network is off')
})

test('timeoutMs 0 with no snapshot entry reports offline rather than pretending the model is unmeasured', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: 0 }), ctx: fakeCtx({ credentials: credentialService(KEY) }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'offline')
  assert.match(result.detail, /timeoutMs is 0/)
  assert.equal(fake.count(), 0)
})

test('timeoutMs 0 is offline even when the snapshot misses, and never a timeout', async () => {
  // Regression pin for the ordering inside `lib/aa/client.js`: the
  // `!networkingEnabled` branch is tested BEFORE `budget.aborted()`.
  // `config.timeoutMs` is the whole network budget, and 0 is documented as
  // "network off" rather than "no time left". Reporting that configuration as
  // `{ reason: 'timeout', detail: 'no answer within 0 ms' }` sends the reader
  // hunting for a network fault — and, together with the born-expired deadline
  // a zero budget used to build, the renderer prints it as "not available:
  // lookup timed out after 1ms" — when the truthful answer is that the local
  // snapshot simply had no entry. Nothing was asked of the network, so nothing
  // could time out: the offline branch must stay ABOVE the abort check.
  //
  // The counterpart — timeoutMs 0 WITH a matching snapshot entry still answers
  // — is pinned by the two tests above; nothing here weakens it.
  const fake = throwingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: 0 }), ctx: fakeCtx({ credentials: credentialService(KEY) }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(
    result.reason,
    'offline',
    'a zero budget is offline, not a timeout: config.timeoutMs 0 switches the network OFF, so the born-expired deadline must be reported as "offline"',
  )
  assert.notEqual(
    result.reason,
    'timeout',
    'config.timeoutMs 0 must never surface as a timeout: "timed out" tells the caller to wait or retry a network that was switched off on purpose',
  )
  assert.match(result.detail, /network lookup is off/, 'the detail must say the network is off')
  assert.match(
    result.detail,
    /local snapshot had no entry/,
    'the detail must name the source that was consulted and came up empty, so the fix is "sync a snapshot"',
  )
  assert.doesNotMatch(
    result.detail,
    /timed out|no answer within/,
    'the offline detail must not claim a timeout: offline mode issues no request, so nothing could time out',
  )
  assert.equal(
    fake.count(),
    0,
    'offline mode must not touch the network even to fail: the fetcher throws, so one attempt would fail this lookup differently',
  )
  assert.deepEqual(fake.urls(), [])
})

test('timeoutMs 0 answers offline for an already-aborted caller, not a timeout', async () => {
  // The same ordering, in the ONE case where `budget.aborted()` is true on a
  // zero budget: `createBudget()` builds no timeout signal when
  // `config.timeoutMs` is 0, so only the caller's own signal can already be
  // aborted. Nothing was ever going to be requested, so there is no deadline
  // to exceed and no work to cancel — "timeout" (or "aborted by the caller")
  // would describe a budget that never existed. This is what makes the
  // ordering load-bearing rather than merely defensive: move the offline
  // branch below the abort check and this lookup reports `timeout` again.
  const fake = throwingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: 0 }),
    ctx: fakeCtx({ credentials: credentialService(KEY) }),
    signal: AbortSignal.abort(),
  })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(
    result.reason,
    'offline',
    'a zero budget is still offline when the caller already aborted: the network was switched off before the caller spoke, so no deadline ever ran and none may be reported',
  )
  assert.notEqual(
    result.reason,
    'timeout',
    'an aborted caller must not turn a switched-off network into a timeout: offline mode made no request, so there was nothing to abort or to wait for',
  )
  assert.match(result.detail, /network lookup is off/, 'the detail must still say the network is off')
  assert.equal(fake.count(), 0, 'a caller abort must not cause a request either')
})

test('a snapshot miss falls through to the page route and is attributed to the page', async () => {
  const snapshotPath = await writeSnapshot([{ ...SNAPSHOT_ENTRY, slug: 'another-model', name: 'Another-Model' }])
  const fake = countingFetch({ page: () => htmlResponse(modelPageHtml()) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({}, { snapshotPath }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.data.sourceOrigin, 'aa-page')
  assert.equal(result.via, 'exact')
  assert.equal(result.sourceUrl, PAGE_URLS[0])
  assert.deepEqual(fake.urls(), [PAGE_URLS[0]], 'the first candidate answers, so the second is never tried')
})

/* ------------------------------------------------------------------ */
/* the deadline                                                        */
/* ------------------------------------------------------------------ */

test('a hanging fetch ends as a graceful timeout inside the budget', async () => {
  // A realistic hanging fetcher: it never produces a response, and it rejects
  // when the deadline signal aborts — which is what the built-in `fetch` does.
  const fake = countingFetch({
    page: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('the operation was aborted')
          error.name = init.signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'
          reject(error)
        })
      }),
  })
  const client = createAaClient({ config: config({ timeoutMs: 25 }), ctx: fakeCtx() })
  await warmSnapshot(client)
  installAaFetcherForTests(fake.fetchImpl)

  // `AbortSignal.timeout` arms an UNREF'd timer, so a test whose only pending
  // work is that timer would let the event loop drain before the deadline can
  // fire. A real request holds a socket, so production needs no such crutch.
  const keepAlive = setTimeout(() => {}, 1_000)
  const started = Date.now()
  let result
  let elapsed
  try {
    result = await client.lookup('test-provider', MODEL)
    elapsed = Date.now() - started
  } finally {
    clearTimeout(keepAlive)
  }

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.match(result.detail, /no answer within 25 ms/)
  assert.ok(elapsed < 500, `the lookup must not outlive its budget (took ${elapsed} ms)`)
  assert.equal(fake.count(), 1, 'the deadline stops the remaining candidate before it is requested')
})

test('the deadline is enforced through the fetch signal, not by racing the promise', async () => {
  // OBSERVED LIMITATION: `createAaClient` awaits the fetcher directly, so a
  // fetcher that ignores `init.signal` is not bounded by `timeoutMs`. `fetch`
  // honours the signal, and the built-in `globalThis.fetch` is what the plugin
  // installs, so the budget holds in production; this test records the
  // boundary rather than pretending the client re-implements it.
  const fake = countingFetch({ page: () => new Promise(() => {}) })
  const client = createAaClient({ config: config({ timeoutMs: 25 }), ctx: fakeCtx() })
  await warmSnapshot(client)
  installAaFetcherForTests(fake.fetchImpl)

  const started = Date.now()
  const pending = client.lookup('test-provider', MODEL).then(() => 'settled')
  await waitFor(() => fake.count() === 1)
  await delay(120)

  const outcome = await Promise.race([pending, delay(1).then(() => 'still-pending')])

  assert.ok(Date.now() - started > 25, 'the deadline has passed')
  assert.equal(outcome, 'still-pending')
  assert.equal(fake.count(), 1, 'no candidate is retried while the first request hangs')
})

test('an already-aborted caller signal fails gracefully without a request', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const controller = new AbortController()
  controller.abort()
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx(), signal: controller.signal })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.detail, 'aborted by the caller')
  assert.equal(fake.count(), 0)
})

test('a caller signal that fires mid-flight aborts the lookup without a rejection', async () => {
  const fake = countingFetch({
    page: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('the operation was aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  installAaFetcherForTests(fake.fetchImpl)
  const controller = new AbortController()
  // A long budget on purpose: only the caller's own abort may explain this
  // failure, so the deadline must be nowhere near it.
  const client = createAaClient({ config: config({ timeoutMs: 30_000 }), ctx: fakeCtx(), signal: controller.signal })
  const pending = client.lookup('test-provider', MODEL)

  // Wait until the request is genuinely in flight: the lookup first probes the
  // (absent) snapshot file, so a fixed sleep would race the filesystem.
  await waitFor(() => fake.count() === 1)
  controller.abort()

  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.detail, 'aborted by the caller')
  assert.equal(fake.count(), 1)
})

/* ------------------------------------------------------------------ */
/* HTTP status mapping, and the promise that nothing is retried         */
/* ------------------------------------------------------------------ */

test('each index status maps onto its own reason, and the index is asked once', async () => {
  const cases = [
    { status: 401, reason: 'key-invalid', headers: {} },
    { status: 403, reason: 'tier', headers: {} },
    { status: 429, reason: 'rate-limited', headers: { 'retry-after': '120' } },
    { status: 500, reason: 'http', headers: {} },
  ]

  for (const { status, reason, headers } of cases) {
    resetAaCacheForTests()
    const fake = countingFetch({
      index: () => jsonResponse({ error: 'nope' }, { status, headers }),
      page: () => htmlResponse('<html></html>', { status: status === 500 ? 500 : 404 }),
    })
    installAaFetcherForTests(fake.fetchImpl)
    const credentials = credentialService(KEY)
    const ctx = fakeCtx({ credentials })
    const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS, debugLog: true }, { indexPages: 1 }), ctx })

    const first = await client.lookup('test-provider', MODEL)

    // The index refusal is recorded with its precise reason…
    assert.equal(client.indexStatus().loaded, false, `status ${status}`)
    assert.equal(client.indexStatus().error, reason, `status ${status}`)
    assert.ok(
      ctx.logs.some((line) => line.includes(`index unavailable (${reason}`)),
      `status ${status} must be logged with its reason: ${ctx.logs.join(' | ')}`,
    )
    if (status === 429) {
      assert.ok(ctx.logs.some((line) => line.includes('retry after 120s')), 'the Retry-After value is reported')
    }

    // …while the keyless page route still runs, so the lookup's own reason is
    // the page route's: `not-on-aa` when every candidate 404s, `http` when the
    // pages fail too. `key-invalid` / `tier` / `rate-limited` are index states.
    assert.equal(first.ok, false, `status ${status}`)
    assert.equal(first.reason, status === 500 ? 'http' : 'not-on-aa', `status ${status}`)

    // One request per URL, ever: the index is not retried, and each candidate
    // page is probed exactly once.
    assert.equal(fake.indexCalls().length, 1, `status ${status}: the index is fetched once`)
    assert.deepEqual(fake.pageCalls().map((call) => call.url), status === 500 ? [PAGE_URLS[0]] : PAGE_URLS)

    // A second lookup for a DIFFERENT model must not re-ask the index either:
    // the failure is remembered for the index error TTL.
    const second = await client.lookup('test-provider', 'Test-Model-B')
    assert.equal(second.ok, false)
    assert.equal(fake.indexCalls().length, 1, `status ${status}: an index failure is not retried per model`)
    assert.equal(credentials.calls.resolve, 2, 'the credential is re-read per lookup, the network is not')
  }
})

test('an index refusal does not stop the page route from answering', async () => {
  const fake = countingFetch({
    index: () => jsonResponse({ error: 'bad key' }, { status: 401 }),
    page: () => htmlResponse(modelPageHtml()),
  })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 1 }),
    ctx: fakeCtx({ credentials: credentialService(KEY) }),
  })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true, 'a broken key degrades to the keyless page route, it does not fail the lookup')
  assert.equal(result.data.sourceOrigin, 'aa-page')
  assert.equal(result.data.scores, 41.25)
  assert.equal(result.via, 'exact')
  assert.equal(client.indexStatus().error, 'key-invalid', 'the refusal is still visible to the operator')
})

test('when no candidate page matches, the answer is not-on-aa after one probe each', async () => {
  const fake = countingFetch({ page: () => htmlResponse('<html><body>404</body></html>', { status: 404 }) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-on-aa')
  assert.match(result.detail, /no AA model page matched test-model-a, test-model-a-next/)
  assert.deepEqual(fake.urls(), PAGE_URLS, 'every candidate is probed once, in order, and none is repeated')

  const again = await client.lookup('test-provider', MODEL)
  assert.equal(again.reason, 'not-on-aa')
  assert.equal(fake.count(), 2, 'a cached failure costs nothing')
})

test('a measurement-free page never yields a number', async () => {
  // Identity without numbers is not an answer to "what does AA say about this
  // model". The route should keep looking and then say so.
  //
  // OBSERVED DEFECT: `hasMeasurements` (`lib/aa/client.js`, the
  // `page.timeToFirstAnswerTokenSeconds !== null` branch) never rejects a
  // parseable page, because `parseAaModelPage` hands over the
  // `{ ttft, reasoning }` object rather than the documented `number|null`, and
  // an object is not `null`. So today the first parseable page is accepted with
  // `{ ok: true }` and every number `null`. The assertion below is the
  // invariant that holds either way — no measurement-free page may ever produce
  // a number — and the accepted branch is what makes the defect visible.
  const bare = (slug) =>
    [
      '<!doctype html><html><head>',
      `<link rel="canonical" href="https://artificialanalysis.ai/models/${slug}">`,
      `<meta property="og:title" content="${MODEL} | Artificial Analysis">`,
      '</head><body>',
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'Dataset', name: 'Output Speed', data: [{ label: MODEL, detailsUrl: `/models/${slug}` }] })}</script>`,
      '</body></html>',
    ].join('')
  const fake = countingFetch({ page: (url) => htmlResponse(bare(url.split('/').pop())) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  if (result.ok === false) {
    assert.equal(result.reason, 'not-on-aa')
    assert.match(result.detail, /published no measurements/)
    assert.deepEqual(fake.urls(), PAGE_URLS, 'both candidates were probed and both were refused')
    return
  }

  // Accepted today: it must still carry no invented number.
  const data = result.data
  assert.equal(data.scores, null)
  assert.equal(data.tokensPerSecond, null)
  assert.equal(data.timeToFirstAnswerTokenSeconds, null)
  assert.equal(data.contextWindow, null)
  assert.equal(data.pricePer1M, null)
  assert.equal(data.scoreName, 'Artificial Analysis Intelligence Index', 'the metric name is not a measurement')
})

/* ------------------------------------------------------------------ */
/* the Free-index route                                                */
/* ------------------------------------------------------------------ */

test('a configured credential makes the Free index the first route', async () => {
  const fake = countingFetch({ index: () => jsonResponse(INDEX_ENVELOPE) })
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = credentialService(KEY)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 1 }),
    ctx: fakeCtx({ credentials }),
  })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.via, 'entry')
  assert.equal(result.sourceUrl, INDEX_URL, 'an index answer is attributed to the index endpoint')
  assert.equal(result.data.sourceOrigin, 'aa-api')
  assert.equal(result.data.scores, 41.25)
  assert.equal(result.data.modelCreator, 'Fixture Labs')
  assert.equal(result.data.scoreVersion, 'v9.9')
  assert.equal(result.data.tokensPerSecond, 88.5)
  assert.equal(result.data.timeToFirstAnswerTokenSeconds, 0.42)
  assert.equal(result.data.contextWindow, 131072)
  assert.equal(result.data.generatedAt, GENERATED_AT)
  assert.equal(fake.indexCalls().length, 1)
  assert.equal(fake.pageCalls().length, 0, 'a hit in the index costs no page fetch')
  assert.deepEqual(client.indexStatus(), { loaded: true, tier: 'free', generatedAt: GENERATED_AT, error: null })
})

test('the index walk follows pagination up to config.aa.indexPages and then caches the result', async () => {
  const fake = countingFetch({
    index: (url) => {
      const page = url.includes('?page=') ? Number(url.split('?page=')[1]) : 1
      return jsonResponse({
        tier: 'free',
        intelligence_index_version: 'v9.9',
        generated_at: GENERATED_AT,
        pagination: { page, page_size: 1, total_pages: 9, has_more: true },
        data: [page === 1 ? RAW_INDEX_ROW : { ...RAW_INDEX_ROW, id: `tm-${page}`, slug: `${SLUG}-${page}`, name: `${MODEL}-${page}` }],
      })
    },
  })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 2 }),
    ctx: fakeCtx({ credentials: credentialService(KEY) }),
  })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.deepEqual(fake.urls(), [INDEX_URL, `${INDEX_URL}?page=2`], 'the clamp stops the walk at two pages')
  assert.equal(client.indexStatus().loaded, true)

  // The index lives for `INDEX_TTL_FLOOR_MS` (6 h) whatever the cache TTL says,
  // so a second model costs no quota at all: it is answered from page 2's entry.
  const second = await client.lookup('test-provider', 'Test-Model-A-2')
  assert.equal(second.ok, true)
  assert.equal(second.via, 'entry')
  assert.deepEqual(
    fake.indexCalls().map((call) => call.url),
    [INDEX_URL, `${INDEX_URL}?page=2`],
    'a fresh index is reused, not refetched',
  )
})

test('with no credential the index is skipped, marked, and never requested', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.reason, 'not-on-aa')
  assert.equal(client.indexStatus().loaded, false)
  assert.equal(client.indexStatus().error, 'no-api-key')
  assert.equal(fake.indexCalls().length, 0)
})

test('a non-POSIX credential name cannot address a credential and is not requested', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = credentialService(KEY)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS }, { credentialRef: 'not a posix name' }),
    ctx: fakeCtx({ credentials }),
  })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.reason, 'not-on-aa')
  assert.equal(credentials.calls.resolve, 0)
  assert.equal(fake.indexCalls().length, 0)
})

/* ------------------------------------------------------------------ */
/* the lookup cache                                                    */
/* ------------------------------------------------------------------ */

test('a successful lookup is cached, and only per provider/model', async () => {
  const fake = countingFetch({ page: () => htmlResponse(modelPageHtml()) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS, cacheTtlMs: 60_000 }), ctx: fakeCtx() })

  const first = await client.lookup('test-provider', MODEL)
  const second = await client.lookup('test-provider', MODEL)

  assert.equal(first.ok, true)
  assert.deepEqual(second, first, 'the cached promise answers with the same result')
  assert.equal(fake.count(), 1, 'a second identical lookup performs no additional fetch')

  await client.lookup('other-provider', MODEL)
  assert.equal(fake.count(), 2, 'the cache key includes the provider route')
})

test('a failure is cached for the shorter TTL and then retried', async () => {
  const fake = countingFetch({ page: () => htmlResponse('<html></html>', { status: 404 }) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS, cacheTtlMs: 60_000, failureTtlMs: 25 }),
    ctx: fakeCtx(),
  })

  const first = await client.lookup('test-provider', MODEL)
  assert.equal(first.reason, 'not-on-aa')
  assert.equal(fake.count(), 2)

  await client.lookup('test-provider', MODEL)
  assert.equal(fake.count(), 2, 'inside failureTtlMs a known failure costs nothing')

  await delay(40)
  await client.lookup('test-provider', MODEL)
  assert.equal(fake.count(), 4, 'after failureTtlMs the lookup is tried again')
})

test('a success outlives the failure TTL', async () => {
  const fake = countingFetch({ page: () => htmlResponse(modelPageHtml()) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS, cacheTtlMs: 60_000, failureTtlMs: 5 }),
    ctx: fakeCtx(),
  })

  await client.lookup('test-provider', MODEL)
  await delay(30)
  const second = await client.lookup('test-provider', MODEL)

  assert.equal(second.ok, true)
  assert.equal(fake.count(), 1, 'the long TTL applies to a success')
})

test('concurrent identical lookups share one in-flight fetch', async () => {
  const fake = countingFetch({
    page: async () => {
      await delay(10)
      return htmlResponse(modelPageHtml())
    },
  })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const [a, b, c] = await Promise.all([
    client.lookup('test-provider', MODEL),
    client.lookup('test-provider', MODEL),
    client.lookup('test-provider', MODEL),
  ])

  assert.equal(fake.count(), 1, 'three callers, one fetch')
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
  assert.equal(a.ok, true)
})

test('a concurrent failure for one model does not poison another', async () => {
  const fake = countingFetch({
    page: (url) => (url.endsWith(`/models/${SLUG}`) ? htmlResponse(modelPageHtml()) : htmlResponse('<html></html>', { status: 404 })),
  })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const [ok, missing] = await Promise.all([
    client.lookup('test-provider', MODEL),
    client.lookup('test-provider', 'Test-Model-B'),
  ])

  assert.equal(ok.ok, true)
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not-on-aa')
  assert.equal(fake.count(), 3, 'one page for A, two candidates for B')
})

/* ------------------------------------------------------------------ */
/* credentials                                                         */
/* ------------------------------------------------------------------ */

test('the key is sent to the index route only, never to a public model page', async () => {
  const fake = countingFetch({
    index: () => jsonResponse({ error: 'nope' }, { status: 401 }),
    page: () => htmlResponse(modelPageHtml()),
  })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx({ credentials: credentialService(KEY) }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(fake.indexCalls().length, 1)
  assert.equal(fake.indexCalls()[0].headers['x-api-key'], KEY)

  assert.equal(fake.pageCalls().length, 1)
  for (const call of fake.pageCalls()) {
    assert.equal(call.headers['x-api-key'], undefined, 'the public page route needs no key')
    assert.equal(call.url.includes(KEY), false)
  }
})

test('the key travels only in the x-api-key header and reaches no result, log or URL', async () => {
  const fake = countingFetch({ index: () => jsonResponse(INDEX_ENVELOPE) })
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = credentialService(KEY)
  const ctx = fakeCtx({ credentials })
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS, debugLog: true }, { indexPages: 1 }),
    ctx,
  })

  const result = await client.lookup('test-provider', MODEL)
  assert.equal(result.ok, true)
  assert.equal(result.via, 'entry')

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(KEY), false, 'no credential value may reach a lookup result')
  assert.equal(serialized.includes('TESTKEY'), false)
  assert.equal(JSON.stringify(client.indexStatus()).includes(KEY), false)

  const indexCall = fake.indexCalls()[0]
  assert.equal(indexCall.headers['x-api-key'], KEY, 'the key is sent as the x-api-key header')
  assert.equal(indexCall.url.includes(KEY), false, 'the key never travels in a URL')
  for (const [name, value] of Object.entries(indexCall.headers)) {
    if (name.toLowerCase() === 'x-api-key') continue
    assert.equal(String(value).includes(KEY), false, `header ${name} must not carry the key`)
  }

  assert.ok(ctx.logs.length > 0, 'debug logging is on for this test')
  for (const line of ctx.logs) {
    assert.equal(line.includes(KEY), false, `a log line leaked the key: ${line}`)
    assert.equal(line.includes('TESTKEY'), false)
  }
})

test('the fallback environment variable is used and equally contained', async () => {
  process.env.AA_API_KEY = ENV_KEY
  const fake = countingFetch({ index: () => jsonResponse(INDEX_ENVELOPE), page: () => htmlResponse(modelPageHtml()) })
  installAaFetcherForTests(fake.fetchImpl)
  // No `ctx.credentials` at all: the process environment is the last layer.
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 1 }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.via, 'entry')
  assert.equal(fake.indexCalls()[0].headers['x-api-key'], ENV_KEY)
  assert.equal(JSON.stringify(result).includes(ENV_KEY), false)
})

test('a credential whose value is empty is treated as absent', async () => {
  const fake = countingFetch({ page: () => htmlResponse('<html></html>', { status: 404 }) })
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = {
    resolve: async () => ({ value: '   ' }),
    describe: async () => ({ configured: false }),
  }
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx({ credentials }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.reason, 'not-on-aa')
  assert.equal(fake.indexCalls().length, 0)
  assert.equal(client.indexStatus().error, 'no-api-key')
})

test('a credential service that throws falls through to the environment', async () => {
  process.env.AA_API_KEY = ENV_KEY
  const fake = countingFetch({ index: () => jsonResponse(INDEX_ENVELOPE) })
  installAaFetcherForTests(fake.fetchImpl)
  const credentials = {
    resolve: async () => {
      throw new Error('the credential store is unavailable')
    },
  }
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 1 }), ctx: fakeCtx({ credentials }) })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.via, 'entry')
  assert.equal(fake.indexCalls()[0].headers['x-api-key'], ENV_KEY)
})

/* ------------------------------------------------------------------ */
/* indexStatus                                                         */
/* ------------------------------------------------------------------ */

test('indexStatus never fetches, before or after a lookup', async () => {
  const fake = countingFetch({ index: () => jsonResponse(INDEX_ENVELOPE) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({
    config: config({ timeoutMs: NO_TIMEOUT_MS }, { indexPages: 1 }),
    ctx: fakeCtx({ credentials: credentialService(KEY) }),
  })

  assert.deepEqual(client.indexStatus(), { loaded: false, tier: null, generatedAt: null, error: null })
  assert.equal(client.indexStatus().loaded, false)
  assert.equal(fake.count(), 0, 'the diagnostic must not warm anything')

  await client.lookup('test-provider', MODEL)
  const before = fake.count()
  const status = client.indexStatus()
  assert.deepEqual(status, { loaded: true, tier: 'free', generatedAt: GENERATED_AT, error: null })
  assert.equal(fake.count(), before, 'reading the status again costs nothing')
})

test('an unreadable snapshot is simply no snapshot', async () => {
  const path = join(workDir, 'broken.json')
  await writeFile(path, '{ this is not json', 'utf8')
  const fake = countingFetch({ page: () => htmlResponse(modelPageHtml()) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }, { snapshotPath: path }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.equal(result.ok, true)
  assert.equal(result.data.sourceOrigin, 'aa-page', 'a broken snapshot must not be a fatal condition')
  assert.equal(fake.count(), 1)
})

test('a snapshot entry with no measurements answers with nulls rather than an invented number', async () => {
  const snapshotPath = await writeSnapshot([{ id: 'tm-a', name: MODEL, slug: SLUG }])
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: 0 }, { snapshotPath }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  // The snapshot route answers with whatever matches by slug or name, so the
  // caller receives the entry; every number on it stays `null` (never 0), and
  // `ok` claims only that a route answered.
  assert.equal(result.ok, true)
  assert.equal(result.data.scores, null)
  assert.equal(result.data.tokensPerSecond, null)
  assert.equal(result.data.pricePer1M, null)
  assert.equal(fake.count(), 0)
})

/* ------------------------------------------------------------------ */
/* the page profile                                                    */
/* ------------------------------------------------------------------ */

test('a page profile is normalized into the client shape and never guesses', async () => {
  const fake = countingFetch({ page: () => htmlResponse(modelPageHtml({ latency: true })) })
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)
  const data = result.data

  assert.equal(result.ok, true)
  assert.equal(result.via, 'exact')
  assert.equal(data.model, MODEL)
  assert.equal(data.rawName, MODEL)
  assert.equal(data.slug, SLUG)
  assert.equal(data.scores, 41.25)
  assert.equal(data.scoreName, 'Artificial Analysis Intelligence Index')
  assert.equal(data.scoreVersion, 'v9.9')
  assert.equal(data.tokensPerSecond, 88.5)
  assert.equal(data.rank, null)
  assert.equal(data.ofCount, null)
  assert.equal(data.pricePer1M, null, 'an all-unknown price triple is reported as null')
  assert.equal(data.generatedAt, null)
  assert.equal(data.sourceOrigin, 'aa-page')
  assert.match(data.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)

  // OBSERVED: `parseAaModelPage` hands over `{ ttft, reasoning }` for the
  // latency field while `dataFromPage` coerces numbers only, so a page's TTFT
  // becomes `null` today. Either way the client never reports the sum, nor a
  // non-number: that invariant is what this assertion protects.
  const ttft = data.timeToFirstAnswerTokenSeconds
  assert.ok(ttft === null || ttft === 0.42, `unexpected TTFT ${JSON.stringify(ttft)}`)
})

test('a genuine zero price survives the trip from a snapshot to the result', async () => {
  const snapshotPath = await writeSnapshot([
    { ...SNAPSHOT_ENTRY, pricePer1M: { input: 0, output: 0, cacheRead: 0 } },
  ])
  installAaFetcherForTests(countingFetch().fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: 0 }, { snapshotPath }), ctx: fakeCtx() })

  const result = await client.lookup('test-provider', MODEL)

  assert.deepEqual(result.data.pricePer1M, { input: 0, output: 0, cacheRead: 0 })
  assert.ok(Object.is(result.data.pricePer1M.input, 0))
})

test('an unusable model id is refused without spending a request', async () => {
  const fake = countingFetch()
  installAaFetcherForTests(fake.fetchImpl)
  const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

  for (const model of ['', '   ', null, undefined, 42]) {
    const result = await client.lookup('test-provider', model)
    assert.equal(result.ok, false, String(model))
    assert.equal(result.reason, 'not-on-aa', String(model))
    assert.match(result.detail, /no model id/)
  }
  assert.equal(fake.count(), 0)
})

test('every failure is a result object, never a rejection', async () => {
  const scenarios = [
    { name: 'network error', page: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) },
    { name: 'throwing fetcher', page: () => { throw new Error('boom') } },
    { name: 'status 0', page: () => htmlResponse('', { status: 0 }) },
    { name: 'body that is not text', page: () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => { throw new Error('stream reset') } }) },
  ]

  for (const scenario of scenarios) {
    resetAaCacheForTests()
    const fake = countingFetch({ page: scenario.page })
    installAaFetcherForTests(fake.fetchImpl)
    const client = createAaClient({ config: config({ timeoutMs: NO_TIMEOUT_MS }), ctx: fakeCtx() })

    const result = await client.lookup('test-provider', MODEL)

    assert.equal(result.ok, false, scenario.name)
    assert.equal(typeof result.reason, 'string', scenario.name)
    assert.equal(typeof result.detail, 'string', scenario.name)
  }
})

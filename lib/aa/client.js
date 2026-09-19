/**
 * Artificial Analysis (AA) lookup client for the better-subagents host plugin.
 *
 * One caller-facing operation, {@link createAaClient} → `lookup(provider, model)`,
 * answers "what does AA say about this model", and one diagnostic,
 * `indexStatus()`. Everything expensive is shared across the whole process:
 * the Free-tier index (100 requests / 24 h, so it is fetched at most once per
 * index TTL window and never retried on failure), the local snapshot file, and
 * the per-model result cache (which stores the *promise*, so concurrent
 * lookups for one model share a single fetch).
 *
 * Three routes, tried in this order, each recording where its data came from:
 *
 *   1. `entry` — the Free index, only when a credential is configured. It is
 *      AA's freshest machine-readable list, so it wins over the local snapshot
 *      and costs no page fetch.
 *   2. `snapshot` — a local `data/aa-snapshot.json` written by
 *      `bin/sync-aa.mjs`. Network-free fallback; `via` is still `exact`/`alias`,
 *      the provenance shows up as `data.sourceOrigin === 'aa-snapshot'`.
 *   3. `exact` / `alias` — the public model page for each candidate slug from
 *      `aaSlugCandidates()`, tried in order until one yields usable numbers.
 *      Always available, needs no key.
 *
 * Nothing is ever written to disk, nothing from AA is redistributed, and no
 * value of a credential — nor any response body — reaches a log. `sourceUrl`
 * and `data.sourceOrigin` exist so the caller can attribute every number it
 * renders.
 *
 * @module dsh-better-subagents/lib/aa/client
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aaSlugCandidates, normalizeModelId } from '../model-id.js'
import { parseAaModelPage, parseAaFreeIndex } from './parse.js'

/** Origin every request goes to. */
const AA_ORIGIN = 'https://artificialanalysis.ai'

/** Free-tier index endpoint, relative to {@link AA_ORIGIN}. */
const FREE_INDEX_PATH = '/api/v2/language/models/free'

/** Credential name used when the configuration names none. */
const DEFAULT_CREDENTIAL_REF = 'AA_API_KEY'

/** Snapshot location used when `config.aa.snapshotPath` is empty; see `index-config.js`. */
const DEFAULT_SNAPSHOT_PATH = fileURLToPath(new URL('../../data/aa-snapshot.json', import.meta.url))

/** Plugin package root, used to anchor a relative snapshot path. */
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Index pages walked when `config.aa.indexPages` is missing. */
const DEFAULT_INDEX_PAGES = 5

/**
 * Floor for the index TTL, whatever `config.cacheTtlMs` says. The endpoint's
 * quota is 100 requests / 24 h and each refresh costs up to `indexPages`
 * requests, so a short cache TTL must not be allowed to drain it.
 */
const INDEX_TTL_FLOOR_MS = 6 * 60 * 60 * 1000

/** How long a failed index attempt is remembered, so a broken key is not retried per model. */
const INDEX_ERROR_TTL_MS = 5 * 60 * 1000

/** Upper bound on cached lookups, so a long session cannot grow without limit. */
const MAX_CACHE_ENTRIES = 500

/** Metric name every score in this plugin comes from. */
const SCORE_NAME = 'Artificial Analysis Intelligence Index'

/** The credential-name grammar: a POSIX shell identifier. */
const POSIX_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Request headers for the Free index: the key travels here, never in a URL. */
const INDEX_HEADERS = { accept: 'application/json', 'accept-encoding': 'gzip' }

/** Request headers for a public model page. */
const PAGE_HEADERS = { accept: 'text/html', 'accept-encoding': 'gzip' }

/**
 * Test-only fetcher override, consulted at call time by the built-in fetcher.
 * `null` means "use the global `fetch`".
 *
 * @type {((url: string, init: object) => Promise<Response>)|null}
 */
let fetchOverride = null

/**
 * Last (or in-flight) index attempt. `at === 0` means "not an attempt worth
 * caching" — either none happened yet or the route was skipped for lack of a
 * credential, which must be re-evaluated on the next lookup.
 */
let indexCache = emptyIndexCache()

/** Lazily read snapshot, keyed by the path it was read from. */
let snapshotCache = { path: null, value: null }

/**
 * Lookup cache: `provider\0model\0snapshotPath` → `{ at, promise, value, settledAt }`.
 * The promise is what is shared; `value`/`settledAt` are filled in when it
 * settles, because a success and a failure have different TTLs.
 *
 * @type {Map<string, { at: number, promise: Promise<object>|null, value: object|undefined, settledAt: number }>}
 */
let lookupCache = new Map()

/**
 * Install (or remove) a test fetcher.
 *
 * The override is global to the module and is used by every client, present and
 * future. Pass `null` to restore the global `fetch`.
 *
 * @param {((url: string, init: object) => Promise<Response>)|null} implementation Replacement fetcher.
 * @returns {void}
 */
export function installAaFetcherForTests(implementation) {
  fetchOverride = typeof implementation === 'function' ? implementation : null
}

/**
 * Drop every cached artifact: the index, the snapshot, and all lookups.
 *
 * @returns {void}
 */
export function resetAaCacheForTests() {
  indexCache = emptyIndexCache()
  snapshotCache = { path: null, value: null }
  lookupCache = new Map()
}

/**
 * Create one lookup client.
 *
 * @param {object} options Client options.
 * @param {object} options.config Resolved plugin config (`lib/index-config.js`).
 * @param {object} [options.ctx] Cordis fiber context; `ctx.get('credentials')` is
 *   used when the harness credential package can be imported.
 * @param {string} [options.credentialRef] Credential *name* (a POSIX identifier
 *   such as `AA_API_KEY`). Defaults to `config.aa.credentialRef`.
 * @param {AbortSignal} [options.signal] Caller signal, combined with the budget.
 * @param {Function} [options.fetchImpl] Explicit fetcher, for tests; otherwise the
 *   module override, otherwise the global `fetch`.
 * @returns {{ lookup: (provider: string, model: string) => Promise<object>, indexStatus: () => { loaded: boolean, tier: string|null, generatedAt: string|null, error: string|null } }}
 *   The client. `lookup` never rejects; an unreachable AA is a result, not an error.
 */
export function createAaClient(options) {
  const opts = isRecord(options) ? options : {}
  const config = isRecord(opts.config) ? opts.config : {}
  const aa = isRecord(config.aa) ? config.aa : {}
  const ctx = opts.ctx
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : builtInFetch
  const callerSignal = opts.signal instanceof AbortSignal ? opts.signal : undefined

  // `config.timeoutMs` is the whole network budget for one lookup. 0 means
  // "no network at all" — but only the network: the local snapshot route still
  // runs, so an operator who synced a snapshot keeps getting scores with the
  // network switched off.
  const networkingEnabled = toFiniteNumber(config.timeoutMs) !== 0
  const timeoutMs = toFiniteNumber(config.timeoutMs)
  const cacheTtlMs = toFiniteNumber(config.cacheTtlMs)
  const failureTtlMs = toFiniteNumber(config.failureTtlMs)
  const debugLog = config.debugLog === true
  // `aa.indexPages` is schema-constrained to 1-20 in `index-config.js`, so a
  // config-validated profile cannot reach the clamp below. It stays anyway:
  // `createAaClient` is a public seam that tests and programmatic callers use
  // directly, and a 0 or 5000 here must not become 0 pages or 5000 requests.
  const indexPages = clampInt(toFiniteNumber(aa.indexPages), 1, 20, DEFAULT_INDEX_PAGES)
  const indexTtlMs = Math.max(toFiniteNumber(config.cacheTtlMs) ?? 0, INDEX_TTL_FLOOR_MS)
  const snapshotPath = resolveSnapshotPath(aa.snapshotPath)
  const credentialName = normalizeCredentialName(
    typeof opts.credentialRef === 'string' ? opts.credentialRef : aa.credentialRef,
  )

  /**
   * Log one decision line, and nothing else: never a key, never a body.
   *
   * @param {string} message Message text.
   * @returns {void}
   */
  function debug(message) {
    if (!debugLog) return
    try {
      ctx?.logger?.info?.(`[better-subagents/aa] ${message}`)
    } catch {
      // A logger that throws must not fail a lookup.
    }
  }

  /**
   * Build the combined deadline for one lookup: the timeout first, then the
   * caller's signal, both filtered so an absent caller signal is fine.
   *
   * @returns {{ signal: AbortSignal|undefined, aborted: () => boolean, budgetExpired: () => boolean, callerAborted: () => boolean }} Budget handle.
   */
  function createBudget() {
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    const parts = [timeoutSignal, callerSignal].filter(Boolean)
    let signal
    if (typeof AbortSignal.any === 'function') {
      signal = parts.length > 0 ? AbortSignal.any(parts) : undefined
    } else {
      signal = timeoutSignal ?? callerSignal ?? undefined
    }
    return {
      signal,
      // The composite is what a fetch sees, so it is also what "already over"
      // means — a budget that ran out between two candidates must stop the next
      // request even before it starts.
      aborted: () => signal !== undefined && signal.aborted,
      budgetExpired: () => timeoutSignal !== undefined && timeoutSignal.aborted,
      callerAborted: () => callerSignal !== undefined && callerSignal.aborted,
    }
  }

  /**
   * The shared failure/abort classification for a fetch that threw.
   *
   * @param {unknown} error Thrown value.
   * @param {{ aborted: () => boolean, budgetExpired: () => boolean, callerAborted: () => boolean }} budget Budget handle.
   * @returns {{ ok: false, reason: string, detail: string }} Failure result.
   */
  function failureFromFetchError(error, budget) {
    if (isAbortLike(error) || budget.aborted()) return timeoutFailure(budget)
    return { ok: false, reason: 'http', detail: `network error (${describeError(error)})` }
  }

  /**
   * Classify an abort: the shared budget or the caller ended the lookup.
   *
   * @param {{ aborted: () => boolean, budgetExpired: () => boolean, callerAborted: () => boolean }} budget Budget handle.
   * @returns {{ ok: false, reason: 'timeout', detail: string }} Failure result.
   */
  function timeoutFailure(budget) {
    if (budget.callerAborted() && !budget.budgetExpired()) {
      return { ok: false, reason: 'timeout', detail: 'aborted by the caller' }
    }
    return { ok: false, reason: 'timeout', detail: `no answer within ${timeoutMs} ms` }
  }

  /**
   * Resolve the credential *presence* first and the key value only when the
   * index route is really about to be used. The value never leaves this scope.
   *
   * The harness's `credentialRef()` helper is preferred, but it is optional:
   * it only validates and compile-time-brands a name, and the brand is the
   * identity at runtime, so the plain POSIX name — already checked against that
   * same grammar by `normalizeCredentialName()` — addresses the same credential
   * when the package cannot be imported from this plugin directory. Without
   * that fallback, a key stored in a `.env` file or in the provider-managed
   * store would be invisible here, because the harness layers those sources
   * behind `ctx.credentials` instead of putting them in `process.env`.
   *
   * @returns {Promise<{ present: boolean, key: string|null }>} Credential state.
   */
  async function resolveCredential() {
    if (credentialName === '') return { present: false, key: null }
    const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials !== undefined && credentials !== null) {
      const helper = await loadCredentialRefHelper()
      let ref = credentialName
      if (helper !== null) {
        try {
          ref = helper(credentialName)
        } catch {
          ref = null
        }
      }
      if (ref !== null) {
        let configured = null
        try {
          if (typeof credentials.describe === 'function') {
            const info = await credentials.describe(ref)
            configured = isRecord(info) ? info.configured === true : null
          }
        } catch {
          configured = null
        }
        if (configured !== false && typeof credentials.resolve === 'function') {
          try {
            const resolved = await credentials.resolve(ref)
            const value = typeof resolved === 'string' ? resolved : resolved?.value
            if (typeof value === 'string' && value.trim() !== '') {
              return { present: true, key: value.trim() }
            }
          } catch {
            // Fall through to the process environment.
          }
        }
      }
    }
    // The last layer, and the only one that exists without `ctx.credentials`.
    const fromEnv = typeof process !== 'undefined' && isRecord(process.env) ? process.env[credentialName] : undefined
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { present: true, key: fromEnv.trim() }
    return { present: false, key: null }
  }

  /**
   * Load the Free index, from cache when it is fresh.
   *
   * One refresh walks up to `indexPages` pages, following `pagination.has_more`
   * and `pagination.total_pages`. Nothing is ever retried: a 401, 403, 429, 5xx
   * or unparseable page is remembered for {@link INDEX_ERROR_TTL_MS} and
   * reported as a reason string the caller can show.
   *
   * @param {string} key Resolved API key (used in a header only).
   * @param {{ signal: AbortSignal|undefined }} budget Budget handle.
   * @returns {Promise<{ ok: true, entries: object, tier: string|null, generatedAt: string|null, version: string|null, count: number }|{ ok: false, reason: string, detail: string }>} Index state.
   */
  async function loadIndex(key, budget) {
    const age = Date.now() - indexCache.at
    if (indexCache.at > 0 && age <= (indexCache.entries === null ? INDEX_ERROR_TTL_MS : indexTtlMs)) {
      if (indexCache.entries !== null) {
        return {
          ok: true,
          entries: indexCache.entries,
          tier: indexCache.tier,
          generatedAt: indexCache.generatedAt,
          version: indexCache.version,
          count: indexCache.count,
        }
      }
      return { ok: false, reason: indexCache.reason ?? 'http', detail: indexCache.detail ?? 'index unavailable' }
    }

    const collected = []
    let tier = null
    let generatedAt = null
    let version = null
    for (let page = 1; page <= indexPages; page += 1) {
      const url = page === 1 ? `${AA_ORIGIN}${FREE_INDEX_PATH}` : `${AA_ORIGIN}${FREE_INDEX_PATH}?page=${page}`
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { ...INDEX_HEADERS, 'x-api-key': key },
          signal: budget.signal,
        })
      } catch (error) {
        return rememberIndexFailure(failureFromFetchError(error, budget))
      }

      const status = Number(response?.status ?? 0)
      if (status === 401) {
        return rememberIndexFailure({ ok: false, reason: 'key-invalid', detail: 'AA rejected the API key (401)' })
      }
      if (status === 403) {
        return rememberIndexFailure({ ok: false, reason: 'tier', detail: 'the API key has no access to the free index (403)' })
      }
      if (status === 429) {
        const retryAfter = readHeader(response, 'retry-after')
        return rememberIndexFailure({
          ok: false,
          reason: 'rate-limited',
          detail: retryAfter === null ? 'AA rate limit reached (429)' : `AA rate limit reached (429), retry after ${retryAfter}s`,
        })
      }
      if (!responseOk(response, status)) {
        return rememberIndexFailure({ ok: false, reason: 'http', detail: `AA answered ${status} for the index` })
      }

      let json
      try {
        json = await response.json()
      } catch (error) {
        if (isAbortLike(error) || budget.aborted()) {
          return rememberIndexFailure(failureFromFetchError(error, budget))
        }
        return rememberIndexFailure({ ok: false, reason: 'http', detail: 'the index response was not JSON' })
      }

      const envelope = isRecord(json) ? json : {}
      if (tier === null) tier = typeof envelope.tier === 'string' ? envelope.tier : null
      if (version === null) version = readIndexVersion(envelope)
      if (generatedAt === null) generatedAt = readIndexGeneratedAt(envelope)
      for (const row of parseAaFreeIndex(json)) collected.push(row)

      const pagination = isRecord(envelope.pagination) ? envelope.pagination : {}
      const totalPages = toFiniteNumber(pagination.total_pages)
      if (pagination.has_more !== true) break
      if (totalPages !== null && page >= totalPages) break
    }

    const entries = buildIndexMaps(collected)
    indexCache = {
      at: Date.now(),
      entries,
      tier,
      generatedAt,
      version,
      error: null,
      detail: null,
      reason: null,
      count: collected.length,
    }
    return { ok: true, entries, tier, generatedAt, version, count: collected.length }
  }

  /**
   * Remember one failed index attempt and return it unchanged.
   *
   * @param {{ ok: false, reason: string, detail: string }} failure Failure to remember.
   * @returns {{ ok: false, reason: string, detail: string }} The same failure.
   */
  function rememberIndexFailure(failure) {
    indexCache = {
      at: Date.now(),
      entries: null,
      tier: null,
      generatedAt: null,
      version: null,
      error: failure.reason,
      detail: failure.detail,
      reason: failure.reason,
      count: 0,
    }
    return failure
  }

  /**
   * Read the local snapshot once per path. A missing, unreadable or malformed
   * file is simply "no snapshot".
   *
   * @returns {Promise<{ bySlug: Map<string, object>, byName: Map<string, object>, generatedAt: string|null, version: string|null, source: string|null }|null>} Snapshot.
   */
  async function readSnapshot() {
    if (snapshotCache.path === snapshotPath) return snapshotCache.value
    let value = null
    try {
      const text = await readFile(snapshotPath, 'utf8')
      const parsed = JSON.parse(text)
      if (isRecord(parsed)) {
        const raw = Array.isArray(parsed.entries) ? parsed.entries : parseAaFreeIndex(parsed)
        const rows = raw.filter(isRecord)
        if (rows.length > 0) {
          value = {
            ...buildIndexMaps(rows),
            generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
            version: typeof parsed.intelligenceIndexVersion === 'string' ? parsed.intelligenceIndexVersion : null,
            source: typeof parsed.source === 'string' ? parsed.source : null,
          }
        }
      }
    } catch {
      value = null
    }
    snapshotCache = { path: snapshotPath, value }
    return value
  }

  /**
   * One lookup, uncached.
   *
   * @param {string} provider Provider route the model belongs to (context for logs and cache keys).
   * @param {string} model Local model id.
   * @returns {Promise<object>} A Lookup result.
   */
  async function runLookup(provider, model) {
    if (aa.enabled === false) return { ok: false, reason: 'disabled', detail: 'config.aa.enabled is false' }

    const modelId = typeof model === 'string' ? model.trim() : ''
    if (modelId === '') return { ok: false, reason: 'not-on-aa', detail: 'the request carried no model id' }

    const budget = createBudget()
    const candidates = candidateSlugs(modelId)
    const normalized = normalizeModelId(modelId)
    const viaFor = (slug) => (slug !== null && slug !== '' && slug === normalized ? 'exact' : 'alias')

    // Every network path below is gated on this: `timeoutMs: 0` keeps the
    // snapshot (and the caller's own profiles, handled upstream) in play while
    // spending no request.
    if (!networkingEnabled) debug('network lookup is off (config.timeoutMs is 0): local sources only')

    // Route 1: the Free index. Needs a credential; costs quota, so it is only
    // consulted when one is really configured.
    const credential = networkingEnabled ? await resolveCredential() : { present: false, key: null }
    if (networkingEnabled && credential.present && credential.key !== null) {
      const loaded = await loadIndex(credential.key, budget)
      if (loaded.ok) {
        debug(`index ready: ${loaded.count} entries, tier=${loaded.tier ?? 'unknown'}`)
        const hit = matchEntry(loaded.entries, modelId, candidates)
        if (hit !== null) {
          debug(`hit: index entry ${describeSlug(hit)} for ${modelId} (provider ${provider})`)
          return success(
            dataFromEntry(hit, modelId, loaded.version, loaded.generatedAt),
            'entry',
            `${AA_ORIGIN}${FREE_INDEX_PATH}`,
          )
        }
        debug(`index miss for ${modelId}; falling back to the snapshot and the model page`)
      } else {
        debug(`index unavailable (${loaded.reason}: ${loaded.detail})`)
        if (loaded.reason === 'timeout') return loaded
      }
    } else if (networkingEnabled) {
      markIndexSkipped()
      debug('index skipped: no AA credential configured')
    }

    // Route 2: the local snapshot, network-free.
    const snapshot = await readSnapshot()
    if (snapshot !== null) {
      const hit = matchEntry(snapshot, modelId, candidates)
      if (hit !== null) {
        debug(`hit: snapshot entry ${describeSlug(hit)} for ${modelId}`)
        return success(
          dataFromEntry(hit, modelId, snapshot.version, snapshot.generatedAt, 'aa-snapshot'),
          viaFor(typeof hit.slug === 'string' ? hit.slug : null),
          snapshot.source ?? AA_ORIGIN,
        )
      }
    }

    // Route 3: the public model page, one candidate slug at a time.
    let sawPage = false
    for (const candidate of networkingEnabled ? candidates : []) {
      if (budget.aborted()) return timeoutFailure(budget)
      const url = `${AA_ORIGIN}/models/${encodeURIComponent(candidate)}`
      let response
      try {
        response = await fetchImpl(url, { method: 'GET', headers: PAGE_HEADERS, signal: budget.signal })
      } catch (error) {
        return failureFromFetchError(error, budget)
      }

      const status = Number(response?.status ?? 0)
      if (status === 404) {
        debug(`page miss: ${candidate} (404)`)
        continue
      }
      if (!responseOk(response, status)) {
        if (budget.aborted()) return timeoutFailure(budget)
        return { ok: false, reason: 'http', detail: `AA answered ${status} for ${candidate}` }
      }

      let html
      try {
        html = await response.text()
      } catch (error) {
        return failureFromFetchError(error, budget)
      }

      const page = parseAaModelPage(html)
      if (page === null) {
        debug(`page unparsable: ${candidate}`)
        continue
      }
      sawPage = true
      if (!hasMeasurements(page)) {
        debug(`page without measurements: ${candidate}`)
        continue
      }
      debug(`hit: page ${candidate} for ${modelId} via ${viaFor(candidate)}`)
      return success(dataFromPage(page, modelId, candidate), viaFor(candidate), url)
    }

    // With the network off, the snapshot was the only source that could have
    // answered; saying so beats claiming AA never measured the model.
    //
    // This is tested BEFORE the deadline check on purpose. A zero budget builds
    // no timeout signal at all (see `createBudget`), so `budget.aborted()` is
    // false for a plain offline lookup — the ordering only becomes observable
    // when the CALLER already aborted, and there the abort check would answer
    // "aborted by the caller" for a lookup that never ran a deadline and never
    // touched the network. The configuration is what failed, so the
    // configuration is what gets reported.
    if (!networkingEnabled) {
      return {
        ok: false,
        reason: 'offline',
        detail: 'config.timeoutMs is 0 (network lookup is off) and the local snapshot had no entry',
      }
    }
    if (budget.aborted()) return timeoutFailure(budget)
    return {
      ok: false,
      reason: 'not-on-aa',
      detail: sawPage
        ? `AA has a page for ${modelId} but published no measurements for it`
        : `no AA model page matched ${candidates.length > 0 ? candidates.join(', ') : modelId}`,
    }
  }

  /**
   * Cached lookup. The promise is cached, so N concurrent callers trigger one
   * fetch; a settled success lives for `config.cacheTtlMs` and a settled
   * failure for `config.failureTtlMs`.
   *
   * @param {string} provider Provider route key.
   * @param {string} model Local model id.
   * @returns {Promise<object>} A Lookup result; never rejects.
   */
  function lookup(provider, model) {
    const cacheKey = `${String(provider ?? '')}\u0000${String(model ?? '')}\u0000${snapshotPath}`
    const cached = readLookupCache(cacheKey)
    if (cached !== null) return cached

    const entry = { at: Date.now(), promise: null, value: undefined, settledAt: 0 }
    const promise = runLookup(provider, model).then(
      (value) => {
        entry.value = value
        entry.settledAt = Date.now()
        return value
      },
      (error) => {
        // runLookup maps every expected failure to a result; this only catches
        // a bug, and still answers rather than rejecting into the tool call.
        const value = { ok: false, reason: 'http', detail: `lookup failed: ${describeError(error)}` }
        entry.value = value
        entry.settledAt = Date.now()
        return value
      },
    )
    entry.promise = promise
    lookupCache.set(cacheKey, entry)
    pruneLookupCache()
    return promise
  }

  /**
   * Cache lookup with per-outcome TTLs.
   *
   * @param {string} cacheKey Cache key.
   * @returns {Promise<object>|null} Cached promise, or `null` when a fresh run is needed.
   */
  function readLookupCache(cacheKey) {
    const entry = lookupCache.get(cacheKey)
    if (entry === undefined || entry.promise === null) return null
    if (entry.value === undefined) return entry.promise
    const ttl = entry.value.ok === true ? cacheTtlMs : failureTtlMs
    if (ttl > 0 && Date.now() - entry.settledAt <= ttl) return entry.promise
    lookupCache.delete(cacheKey)
    return null
  }

  /**
   * Keep the lookup cache bounded; the oldest entries go first.
   *
   * @returns {void}
   */
  function pruneLookupCache() {
    if (lookupCache.size <= MAX_CACHE_ENTRIES) return
    const overflow = lookupCache.size - MAX_CACHE_ENTRIES
    let removed = 0
    for (const key of lookupCache.keys()) {
      lookupCache.delete(key)
      removed += 1
      if (removed >= overflow) break
    }
  }

  /**
   * Mark that the index route was skipped for lack of a credential, without
   * poisoning the cache: `at: 0` means the next lookup decides again.
   *
   * @returns {void}
   */
  function markIndexSkipped() {
    if (indexCache.entries !== null) return
    indexCache = { ...emptyIndexCache(), error: 'no-api-key' }
  }

  /**
   * The last index attempt's state. Never fetches.
   *
   * @returns {{ loaded: boolean, tier: string|null, generatedAt: string|null, error: string|null }} Index status.
   */
  function indexStatus() {
    return {
      loaded: indexCache.entries !== null,
      tier: indexCache.tier ?? null,
      generatedAt: indexCache.generatedAt ?? null,
      error: indexCache.error ?? null,
    }
  }

  return { lookup, indexStatus }
}

// ---------------------------------------------------------------------------
// data builders
// ---------------------------------------------------------------------------

/**
 * Build the caller-facing profile from a Free-index or snapshot entry.
 *
 * @param {Record<string, unknown>} entry Normalized entry.
 * @param {string} model Local model id this profile belongs to.
 * @param {string|null} version Index version stated by the envelope.
 * @param {string|null} generatedAt Data generation timestamp.
 * @param {'aa-api'|'aa-snapshot'} origin Provenance tag.
 * @returns {object} Profile data.
 */
function dataFromEntry(entry, model, version, generatedAt, origin = 'aa-api') {
  return {
    rawName: typeof entry.name === 'string' ? entry.name : null,
    slug: typeof entry.slug === 'string' ? entry.slug : null,
    modelCreator: typeof entry.modelCreator === 'string' ? entry.modelCreator : null,
    rank: toFiniteNumber(entry.rank),
    ofCount: toFiniteNumber(entry.ofCount),
    scores: toFiniteNumber(entry.scores),
    scoreName: typeof entry.scoreName === 'string' && entry.scoreName !== '' ? entry.scoreName : SCORE_NAME,
    scoreVersion: typeof entry.scoreVersion === 'string' ? entry.scoreVersion : version,
    tokensPerSecond: toFiniteNumber(entry.tokensPerSecond),
    timeToFirstAnswerTokenSeconds: toFiniteNumber(entry.timeToFirstAnswerTokenSeconds),
    pricePer1M: normalizePrice(entry.pricePer1M),
    contextWindow: toFiniteNumber(entry.contextWindow),
    sourceOrigin: origin,
    fetchedAt: new Date().toISOString(),
    generatedAt: generatedAt ?? (typeof entry.generatedAt === 'string' ? entry.generatedAt : null),
    model,
  }
}

/**
 * Build the caller-facing profile from a parsed model page.
 *
 * @param {object} page {@link parseAaModelPage} result.
 * @param {string} model Local model id this profile belongs to.
 * @param {string} slug Slug that answered.
 * @returns {object} Profile data.
 */
function dataFromPage(page, model, slug) {
  return {
    rawName: typeof page.name === 'string' ? page.name : null,
    slug: typeof page.slug === 'string' && page.slug !== '' ? page.slug : slug,
    modelCreator: typeof page.creator === 'string' ? page.creator : null,
    rank: toFiniteNumber(page.rank),
    ofCount: toFiniteNumber(page.ofCount),
    scores: toFiniteNumber(page.scores),
    scoreName: typeof page.scoreName === 'string' && page.scoreName !== '' ? page.scoreName : SCORE_NAME,
    scoreVersion: typeof page.scoreVersion === 'string' ? page.scoreVersion : null,
    tokensPerSecond: toFiniteNumber(page.tokensPerSecond),
    timeToFirstAnswerTokenSeconds: readLatencyNumber(page.timeToFirstAnswerTokenSeconds),
    pricePer1M: normalizePrice(page.pricePer1M),
    contextWindow: toFiniteNumber(page.contextWindow),
    sourceOrigin: 'aa-page',
    fetchedAt: new Date().toISOString(),
    generatedAt: typeof page.generatedAt === 'string' ? page.generatedAt : null,
    model,
  }
}

/**
 * Build a successful Lookup.
 *
 * @param {object} data Profile data.
 * @param {'entry'|'alias'|'exact'} via Route that answered.
 * @param {string} sourceUrl Where the numbers came from, for attribution.
 * @returns {{ ok: true, data: object, via: string, sourceUrl: string, fetchedAt: string }} Lookup result.
 */
function success(data, via, sourceUrl) {
  return { ok: true, data, via, sourceUrl, fetchedAt: data.fetchedAt }
}

/**
 * Normalize a price triple: all-unknown becomes `null`, and each unknown stays
 * `null` (never `0`, which AA uses for a genuinely free route).
 *
 * @param {unknown} price Candidate price object.
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null }|null} Prices.
 */
function normalizePrice(price) {
  if (!isRecord(price)) return null
  const input = toFiniteNumber(price.input)
  const output = toFiniteNumber(price.output)
  const cacheRead = toFiniteNumber(price.cacheRead)
  if (input === null && output === null && cacheRead === null) return null
  return { input, output, cacheRead }
}

// ---------------------------------------------------------------------------
// lookup plumbing
// ---------------------------------------------------------------------------

/**
 * The slug candidates to probe, tolerating a malformed helper result.
 *
 * @param {string} modelId Local model id.
 * @returns {string[]} Candidate slugs, most likely first.
 */
function candidateSlugs(modelId) {
  try {
    const candidates = aaSlugCandidates(modelId)
    if (!Array.isArray(candidates)) return [normalizeModelId(modelId)].filter((slug) => slug !== '')
    return candidates.filter((slug) => typeof slug === 'string' && slug.trim() !== '').map((slug) => slug.trim().toLowerCase())
  } catch {
    const normalized = normalizeModelId(modelId)
    return normalized === '' ? [] : [normalized]
  }
}

/**
 * Find a model in an index-like container (index maps or snapshot maps).
 *
 * @param {{ bySlug: Map<string, object>, byName: Map<string, object> }} source Indexed entries.
 * @param {string} modelId Local model id.
 * @param {string[]} candidates Candidate slugs.
 * @returns {Record<string, unknown>|null} Matching entry.
 */
function matchEntry(source, modelId, candidates) {
  const bySlug = source?.bySlug
  const byName = source?.byName
  if (!(bySlug instanceof Map) || !(byName instanceof Map)) return null
  for (const candidate of candidates) {
    const hit = bySlug.get(normKey(candidate))
    if (hit !== undefined) return hit
  }
  const idKey = normKey(modelId)
  if (idKey === '') return null
  return bySlug.get(idKey) ?? byName.get(idKey) ?? null
}

/**
 * Index entries by normalized slug and normalized name.
 *
 * @param {Array<Record<string, unknown>>} rows Normalized entries.
 * @returns {{ bySlug: Map<string, object>, byName: Map<string, object> }} Indexed entries.
 */
function buildIndexMaps(rows) {
  const bySlug = new Map()
  const byName = new Map()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const slugKey = normKey(row.slug)
    if (slugKey !== '' && !bySlug.has(slugKey)) bySlug.set(slugKey, row)
    const nameKey = normKey(row.name)
    if (nameKey !== '' && !byName.has(nameKey)) byName.set(nameKey, row)
  }
  return { bySlug, byName }
}

/**
 * Whether a parsed page carries at least one real measurement. A page that only
 * yields a title is not an answer to "what does AA say about this model".
 *
 * @param {object} page {@link parseAaModelPage} result.
 * @returns {boolean} True when some number is present.
 */
function hasMeasurements(page) {
  // Every test below is a `typeof`/finite check rather than a `!== null` one: a
  // measurement that arrives as a non-number must not count as a measurement,
  // or an unmeasured page would be reported as a confirmed AA profile.
  if (isFiniteNumber(page.scores) || isFiniteNumber(page.tokensPerSecond)) return true
  if (isFiniteNumber(page.timeToFirstAnswerTokenSeconds) || isFiniteNumber(page.contextWindow)) return true
  const price = page.pricePer1M
  if (!isRecord(price)) return false
  return isFiniteNumber(price.input) || isFiniteNumber(price.output) || isFiniteNumber(price.cacheRead)
}

/**
 * The built-in fetcher: the test override when one is installed, else the
 * global `fetch`.
 *
 * @param {string} url Request URL.
 * @param {object} init Request init, including the combined signal.
 * @returns {Promise<Response>} Response.
 */
function builtInFetch(url, init) {
  if (typeof fetchOverride === 'function') return fetchOverride(url, init)
  if (typeof globalThis.fetch !== 'function') {
    return Promise.reject(new Error('global fetch is unavailable in this runtime'))
  }
  return globalThis.fetch(url, init)
}

/**
 * Load the harness credential helper, once.
 *
 * The package lives in the harness's own dependency tree, which a `link:`-ed
 * plugin directory cannot necessarily resolve, so the import is dynamic and a
 * failure is not fatal: {@link resolveCredential} then addresses the credential
 * by its bare POSIX name and still falls back to `process.env`.
 *
 * @returns {Promise<((value: string) => unknown)|null>} `credentialRef`, or `null`.
 */
let credentialRefHelper
async function loadCredentialRefHelper() {
  if (credentialRefHelper !== undefined) return credentialRefHelper
  credentialRefHelper = null
  try {
    const module = await import('@deepseek-ai/dsh-credentials')
    if (typeof module?.credentialRef === 'function') credentialRefHelper = module.credentialRef
  } catch {
    credentialRefHelper = null
  }
  return credentialRefHelper
}

/**
 * Normalize a configured credential name: it must be a POSIX shell identifier,
 * which is also the grammar the harness credential references use.
 *
 * @param {unknown} value Configured name.
 * @returns {string} Name, or `''` when it cannot name a credential.
 */
function normalizeCredentialName(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return DEFAULT_CREDENTIAL_REF
  return POSIX_NAME_RE.test(raw) ? raw : ''
}

/**
 * Resolve the snapshot path: the configured one when given (relative paths are
 * anchored at the plugin root, not the process cwd), else the packaged default
 * location.
 *
 * @param {unknown} configured `config.aa.snapshotPath`.
 * @returns {string} Absolute snapshot path.
 */
function resolveSnapshotPath(configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (value === '') return DEFAULT_SNAPSHOT_PATH
  return isAbsolute(value) ? value : resolve(PLUGIN_ROOT, value)
}

/**
 * Index version from the envelope, under either documented spelling.
 *
 * @param {Record<string, unknown>} envelope Index response.
 * @returns {string|null} Version such as `v4.3`.
 */
function readIndexVersion(envelope) {
  for (const key of ['intelligence_index_version', 'intelligenceIndexVersion']) {
    const value = envelope[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Generation timestamp from the envelope, under either documented spelling.
 *
 * @param {Record<string, unknown>} envelope Index response.
 * @returns {string|null} ISO-8601 timestamp.
 */
function readIndexGeneratedAt(envelope) {
  for (const key of ['generated_at', 'generatedAt', 'updated_at', 'updatedAt']) {
    const value = envelope[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * A fresh, empty index cache that is not treated as an attempt.
 *
 * @returns {object} Empty index cache.
 */
function emptyIndexCache() {
  return {
    at: 0,
    entries: null,
    tier: null,
    generatedAt: null,
    version: null,
    error: null,
    detail: null,
    reason: null,
    count: 0,
  }
}

/**
 * Whether a fetch response counts as OK. A real `Response` carries `ok`; a test
 * stub may carry only a status, which is read the same way.
 *
 * @param {Response} response Fetch response.
 * @param {number} status Already-read status code.
 * @returns {boolean} True for a 2xx response.
 */
function responseOk(response, status) {
  if (typeof response?.ok === 'boolean') return response.ok
  return status >= 200 && status < 300
}

/**
 * Read a response header without trusting the Response to be a real one.
 *
 * @param {Response} response Fetch response.
 * @param {string} name Header name.
 * @returns {string|null} Header value.
 */
function readHeader(response, name) {
  try {
    const value = response?.headers?.get?.(name)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * Whether a thrown value is an abort (the timeout signal aborts with
 * `TimeoutError`, a caller signal with `AbortError`).
 *
 * @param {unknown} error Thrown value.
 * @returns {boolean} True for abort-like errors.
 */
function isAbortLike(error) {
  if (!isRecord(error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

/**
 * A short, safe description of a thrown value: names and messages only, never
 * request or response contents.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Description.
 */
function describeError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  return 'unknown error'
}

/**
 * A slug for logs, without ever spending a fetch on it.
 *
 * @param {Record<string, unknown>} entry Index entry.
 * @returns {string} Slug or name.
 */
function describeSlug(entry) {
  if (typeof entry.slug === 'string' && entry.slug !== '') return entry.slug
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name
  return '(unnamed entry)'
}

/**
 * Comparison key for slugs and names: lowercase, alphanumerics only.
 *
 * @param {unknown} value Candidate text.
 * @returns {string} Normalized key.
 */
function normKey(value) {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Coerce to a finite number, preserving a genuine `0` and rejecting everything
 * else (including `null`, strings and `NaN`).
 *
 * @param {unknown} value Candidate.
 * @returns {number|null} Number, or `null`.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return null
}

/**
 * Clamp an optional integer into range.
 *
 * @param {number|null} value Candidate value.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @param {number} fallback Value used when absent.
 * @returns {number} Clamped integer.
 */
function clampInt(value, min, max, fallback) {
  if (value === null) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Whether a value is a plain JSON object.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} True for non-null, non-array objects.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a value is a usable measurement rather than an absent one.
 *
 * `null` means "AA did not measure this", and is the only absent value the
 * parser is contracted to produce; anything else that is not a finite number is
 * treated the same way so a malformed measurement can never count as data.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} True for a finite number.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read the published answer-token latency as a number.
 *
 * Accepts the documented `number` shape and, defensively, the `{ ttft }` shape a
 * page parser once produced: the field feeds a `number|null` contract, so an
 * object must never reach it. A missing `ttft` is "not measured".
 *
 * @param {unknown} value Parsed latency.
 * @returns {number|null} Seconds, or `null`.
 */
function readLatencyNumber(value) {
  if (isFiniteNumber(value)) return value
  if (isRecord(value)) return toFiniteNumber(value.ttft)
  return null
}

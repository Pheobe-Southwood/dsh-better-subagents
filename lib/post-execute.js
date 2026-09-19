/**
 * Enrichment of the native `list_subagent_models` result.
 *
 * This module registers one `tools/post-execute` waterfall listener. When the
 * finished tool is the native `list_subagent_models` and the call succeeded, it
 * appends an authoritative profile block (Artificial Analysis score/speed/
 * latency/price, pi-ai USD rates, and runtime adapter facts) for exactly the
 * routes the calling Session is authorized to delegate to. Every other outcome
 * is passed through untouched.
 *
 * ## Modes
 *
 * The native call has three shapes and all three are enrichable:
 *
 * - `{ provider, model }` — one route; its line is profiled in the dossier
 *   layout.
 * - `{ provider }` — the provider's advertised models; each authorized line is
 *   profiled in the compact layout.
 * - no arguments — the PROVIDER list. This is the mode in which an Agent
 *   enumerates its delegation routes, so a line that already names a model is
 *   used directly, while a bare provider line is resolved to that provider's
 *   advertised models first: in memory through the `llm` service
 *   (`listModels`, the same call the native tool makes), and only when no host
 *   service exposes models through the native listing surface itself. When
 *   neither source is reachable in the calling context, the Session's own
 *   authorized routes for that provider are the candidate set — authorized by
 *   construction, so this can only ever profile a route the Session may
 *   really delegate to. The extra work stays bounded — at most one lookup per
 *   distinct provider, all under the same `config.timeoutMs` deadline, none
 *   retried, no failure surfaced.
 *
 * ## Platform caveats (verified against the installed build)
 *
 * 1. A tool's own `finalizeContent` runs AFTER this waterfall and can overwrite
 *    the decision returned here. The native `list_subagent_models` definition
 *    declares no `finalizeContent` (verified), so the appended block is not
 *    rewritten; a future definition that declares one would win.
 * 2. Caller cancellation can replace an accepted successful outcome: after
 *    listeners settle, the registry may substitute the cancellation code, which
 *    discards this enrichment. Nothing here prevents that, and nothing should —
 *    the enrichment is advisory text.
 *
 * ## Failure policy
 *
 * A listener that throws converts a good tool result into an `isError` result,
 * so this handler NEVER throws: every step is individually guarded, any
 * unexpected shape falls back to `next()`, and the whole body is wrapped in a
 * final try/catch. Authorization is mandatory: when the authorized routes for
 * the calling Session cannot be determined, the native result is returned
 * unchanged rather than enriched with a guess.
 *
 * @module dsh-better-subagents/post-execute
 */

import { NATIVE_TOOL_NAME, detectMode, extractText, parseModelDetail, parseModelList, parseProviderList, parseProviderRoutes } from './native-listing.js'
import { authorizedRoutes as defaultAuthorizedRoutes } from './authorization.js'
import { formatProfileLines, mergeProfile, resolveConfiguredProfile } from './catalog.js'
import { createAaClient as defaultCreateAaClient } from './aa/client.js'
import { readPiAiFacts as defaultReadPiAiFacts } from './pi-ai-catalog.js'

/** Suffix appended to a parsed model line the Session may not delegate to. */
const UNAUTHORIZED_SUFFIX = ' \u2014 not authorized for delegation in this Session'

/**
 * The credit line `lib/catalog.js` appends to every rendered block. It is
 * mirrored here only to RECOGNIZE that line while assembling a list; the
 * renderer owns its text and wording.
 */
const AA_ATTRIBUTION_LINE = 'Source: Artificial Analysis (artificialanalysis.ai)'

/** Default bound for the optional setup-time snapshot warm-up. */
const SETUP_DEADLINE_MS = 10_000

/**
 * Deadline for resolving a bare provider's advertised models when the config
 * names no `timeoutMs`.
 *
 * A configured `timeoutMs` is ALWAYS used when present, so this constant only
 * keeps an unconfigured plugin bounded: resolving models must never be able to
 * stall the tool result that is waiting on this waterfall.
 */
const PROVIDER_MODEL_DEADLINE_MS = 5_000

/** The only host whose search results may be believed; see {@link readWebSearch}. */
const AA_HOST = 'artificialanalysis.ai'

/** How many search hits the last-resort confirmation asks for, and no more. */
const WEB_SEARCH_MAX_RESULTS = 5

/**
 * Whether a URL belongs to Artificial Analysis.
 *
 * Parsed rather than prefix-matched, so `https://evil.example/?u=artificialanalysis.ai`
 * and `https://artificialanalysis.ai.evil.example/` are both rejected.
 *
 * @param {unknown} value - candidate URL from a search result.
 * @returns {boolean} true only for the AA host or a subdomain of it.
 */
function isAaUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const { hostname } = new URL(value)
    return hostname === AA_HOST || hostname.endsWith(`.${AA_HOST}`)
  } catch {
    return false
  }
}

/**
 * Read a service without letting a throwing context break setup.
 *
 * @param {any} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {any} the service, or `null`.
 */
function safeService(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}

/**
 * Describe an unknown thrown value for a debug line.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} short text.
 */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Build a debug logger that can never affect the tool result.
 *
 * `config.debugLog` may be `true` (use the plugin logger), `false`/absent (no
 * output), or a function called with one line of text.
 *
 * @param {any} ctx - plugin context.
 * @param {any} config - plugin config.
 * @returns {(message: string) => void} the logger.
 */
function debugLogger(ctx, config) {
  const candidate = config?.debugLog
  const sink = typeof candidate === 'function' ? candidate : null
  let logger = null
  if (sink === null && candidate === true) {
    try {
      const base = ctx?.logger
      if (typeof base === 'function') logger = base('better-subagents')
      else if (base !== null && base !== undefined) logger = base
    } catch {
      logger = null
    }
  }
  return (message) => {
    try {
      if (sink !== null) {
        sink(message)
        return
      }
      if (logger === null) return
      if (typeof logger.debug === 'function') logger.debug(message)
      else if (typeof logger.info === 'function') logger.info(message)
    } catch {
      // Debug output must never change a tool result.
    }
  }
}

/**
 * Read the first explicit boolean among candidate config keys.
 *
 * @param {unknown[]} values - candidate values.
 * @param {boolean} fallback - value used when none is a boolean.
 * @returns {boolean} the resolved flag.
 */
function booleanFlag(values, fallback) {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return fallback
}

/**
 * Whether a config value points at a loadable AA snapshot/index artifact.
 *
 * @param {any} config - plugin config.
 * @returns {boolean} whether a snapshot warm-up should be attempted.
 */
function snapshotConfigured(config) {
  const nested = config?.aa !== null && typeof config?.aa === 'object' ? config.aa : null
  const candidates = [
    config?.snapshot,
    config?.snapshotPath,
    config?.snapshotFile,
    config?.indexPath,
    nested?.snapshot,
    nested?.snapshotPath,
    nested?.snapshotFile,
    nested?.indexPath,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return true
    if (value !== null && typeof value === 'object' && value.enabled !== false) return true
  }
  return false
}

/**
 * Await a promise with a bounded deadline that never rejects.
 *
 * @param {Promise<unknown>} promise - work to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<unknown>} the value, or `undefined` when the deadline wins.
 */
async function withDeadline(promise, ms) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Append a suffix to one line of a multi-line result text.
 *
 * Appending never changes the line count, so line indices remain valid for
 * later entries.
 *
 * @param {string} text - current text.
 * @param {number} lineIndex - zero-based line index.
 * @param {string} suffix - text to append.
 * @returns {string} the annotated text.
 */
function annotateLine(text, lineIndex, suffix) {
  const lines = text.split('\n')
  if (lineIndex < 0 || lineIndex >= lines.length) return text
  lines[lineIndex] = `${lines[lineIndex]}${suffix}`
  return lines.join('\n')
}

/**
 * Rebuild a result's content blocks around replacement text.
 *
 * The chosen, deterministic rule: every text block is joined into ONE text
 * block placed at the position of the FIRST text block, and every non-text
 * block (images, resources) is preserved by reference in place. Later text
 * blocks are dropped rather than duplicated, because their text is already part
 * of the joined replacement.
 *
 * @param {unknown} content - original `result.content`.
 * @param {string} text - replacement text.
 * @returns {{ type: 'text', text: string }[]|any[]} rebuilt content blocks.
 */
function rebuildContent(content, text) {
  const blocks = Array.isArray(content) ? content : []
  const rebuilt = []
  let placed = false
  for (const block of blocks) {
    const isText = block !== null && typeof block === 'object' && block.type === 'text'
    if (!isText) {
      rebuilt.push(block)
      continue
    }
    if (placed) continue
    rebuilt.push({ type: 'text', text })
    placed = true
  }
  if (!placed) rebuilt.push({ type: 'text', text })
  return rebuilt
}

/**
 * Read one settled `Promise.allSettled` slot.
 *
 * @param {any} settled - settled result.
 * @returns {any} the fulfilled value, or `null`.
 */
function settledValue(settled) {
  return settled !== null && settled !== undefined && settled.status === 'fulfilled'
    ? settled.value ?? null
    : null
}

/**
 * Join per-route profile blocks into the appended block.
 *
 * The credit line is generic, so repeating it once per route would spend model
 * context on duplicates; only the final block keeps it. A per-route
 * `Source URL:` line stays with its own route, because that provenance differs
 * per model (index entry, snapshot, or model page). A block always starts with
 * its identity line, so filtering can never leave a block empty.
 *
 * @param {string[][]} blocks - per-route line arrays.
 * @returns {string} the joined block text.
 */
function joinBlocks(blocks) {
  const last = blocks.length - 1
  return blocks
    .map((lines, index) => (index === last ? lines : lines.filter((line) => line !== AA_ATTRIBUTION_LINE)))
    .map((lines) => lines.join('\n'))
    .join('\n\n')
}

/**
 * Reuse the native listing parser in one call.
 *
 * Provided for tests and for callers that need the native shapes without
 * importing the parser module directly.
 *
 * @param {unknown} text - native result text.
 * @returns {{
 *   mode: 'providers'|'models'|'model'|'unknown',
 *   providers: { provider: string, name: string }[],
 *   models: { provider: string, model: string, name: string, description: string|null }[],
 *   detail: { provider: string, model: string, name: string, description: string|null, reasoningSyntax: string|null }|null,
 * }} the parsed shapes; only the field matching `mode` is non-empty.
 */
export function parseNativeResult(text) {
  const detail = parseModelDetail(text)
  const models = parseModelList(text)
  const providers = parseProviderList(text)
  const mode = detail !== null
    ? 'model'
    : models.length > 0
      ? 'models'
      : providers.length > 0
        ? 'providers'
        : 'unknown'
  return { mode, providers, models, detail }
}

/**
 * Create the enrichment handler.
 *
 * The returned function takes the waterfall's `(exec, result, next)` and always
 * resolves to a `PostToolDecision`: `next()` (the untouched native decision) for
 * every skip, failure, or unknown-authorization case, or
 * `{ kind: 'accept', content }` with the enriched text. `next` is optional so a
 * test can call the handler with two arguments and receive a deterministic
 * `{ kind: 'accept' }` for "unchanged".
 *
 * @param {any} ctx - plugin context.
 * @param {any} config - normalized plugin config.
 * @param {{
 *   llm?: any, aa?: any, web?: any, createAaClient?: Function, readPiAiFacts?: Function,
 *   authorizedRoutes?: Function, now?: Function,
 * }} [deps] - injectable seams; every omitted key uses the real implementation.
 * @returns {(exec: any, result: any, next?: Function) => Promise<any>} the handler.
 */
export function createEnricher(ctx, config, deps) {
  const cfg = config ?? {}
  const log = debugLogger(ctx, cfg)
  const overrides = deps !== null && typeof deps === 'object' ? deps : {}
  const defaults = {
    llm: safeService(ctx, 'llm'),
    aa: null,
    // Optional by design: a host plugin that never injected `web` gets `null`,
    // and the last-resort search below is then a no-op.
    web: safeService(ctx, 'web'),
    createAaClient: defaultCreateAaClient,
    readPiAiFacts: defaultReadPiAiFacts,
    authorizedRoutes: defaultAuthorizedRoutes,
    now: () => Date.now(),
  }
  const seams = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (overrides[key] !== undefined) seams[key] = overrides[key]
  }
  const llmPinned = overrides.llm !== undefined

  const debugEnabled = cfg.debugLog === true || typeof cfg.debugLog === 'function'
  /**
   * Emit one debug line without building its text when debugging is off.
   *
   * @param {string|(() => string)} message - text or text builder.
   */
  const debug = (message) => {
    if (!debugEnabled) return
    log(typeof message === 'function' ? message() : message)
  }

  const showWhenToUse = booleanFlag([cfg.showWhenToUse, cfg.whenToUseShow, cfg.showWhenNotTo], true)
  const includeAttribution = booleanFlag(
    [cfg.includeAttribution, cfg.attribution, cfg.showAttribution, cfg.sourceAttribution],
    true,
  )
  const timeoutMs = typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : null
  // Opt-in, exactly `true`: an absent or non-boolean value keeps the released
  // search surface untouched.
  const webSearchEnabled = cfg.webSearch === true

  /** One lazily created AA client per enricher, so index and lookup caches are shared. */
  let aaClient = seams.aa
  let aaClientReady = seams.aa !== null && seams.aa !== undefined

  /**
   * Read the shared AA client, creating it on first use.
   *
   * @returns {any} the client, or `null` when it cannot be created.
   */
  function getAaClient() {
    if (aaClientReady) return aaClient
    try {
      aaClient = typeof seams.createAaClient === 'function' ? seams.createAaClient({ config: cfg, ctx }) : null
    } catch (error) {
      log(`aa client creation failed: ${describeError(error)}`)
      aaClient = null
    }
    if (aaClient !== null && aaClient !== undefined) aaClientReady = true
    return aaClient ?? null
  }

  /**
   * Read the authorized routes for one call.
   *
   * @param {any} exec - tool execution.
   * @returns {Promise<{ provider: string, model: string }[]|undefined>} routes.
   */
  async function readRoutes(exec) {
    if (typeof seams.authorizedRoutes !== 'function') return undefined
    return await seams.authorizedRoutes(ctx, exec)
  }

  /**
   * Read the LLM service, re-resolving the default once if it mounted late.
   *
   * A deployment can mount the enrichable tool before the `llm` service
   * activates; an injected seam is honoured as final, while the default keeps
   * looking until it finds one.
   *
   * @returns {any} the service, or `null`.
   */
  function currentLlm() {
    if (seams.llm !== null && seams.llm !== undefined) return seams.llm
    if (llmPinned) return null
    const late = safeService(ctx, 'llm')
    if (late !== null) seams.llm = late
    return late
  }

  /**
   * Read runtime adapter facts for one route.
   *
   * A missing `llm` service and a failing `resolveModelInfo` both yield `null`,
   * which is why each is reported on the debug channel: an unreachable runtime
   * silently downgrades the context window to a catalogue figure, and that is
   * exactly the symptom an operator needs to tell apart from a route the
   * adapter genuinely cannot describe.
   *
   * @param {{ provider: string, model: string }} entry - route.
   * @param {any} exec - tool execution carrying the caller signal.
   * @returns {Promise<any>} resolved model info, or `null`.
   */
  async function readRuntime(entry, exec) {
    const llm = currentLlm()
    if (llm === null || llm === undefined || typeof llm.resolveModelInfo !== 'function') {
      debug(() => `runtime facts unavailable for ${entry.provider}/${entry.model}: no \`llm\` service exposing resolveModelInfo in this context`)
      return null
    }
    try {
      return (await llm.resolveModelInfo(entry.provider, entry.model, exec?.signal)) ?? null
    } catch (error) {
      debug(() => `runtime facts failed for ${entry.provider}/${entry.model}: ${describeError(error)}`)
      return null
    }
  }

  /**
   * Read bundled pi-ai catalogue facts for one route.
   *
   * @param {{ provider: string, model: string }} entry - route.
   * @returns {Promise<any>} pi-ai facts, or `null`.
   */
  async function readPiAi(entry) {
    if (typeof seams.readPiAiFacts !== 'function') return null
    return (await seams.readPiAiFacts(entry.provider, entry.model)) ?? null
  }

  /**
   * Run the Artificial Analysis lookup for one route.
   *
   * @param {{ provider: string, model: string }} entry - route.
   * @returns {Promise<any>} the lookup result, or `null`.
   */
  async function readAa(entry) {
    const client = getAaClient()
    if (client === null || typeof client.lookup !== 'function') return null
    return (await client.lookup(entry.provider, entry.model)) ?? null
  }

  /**
   * Last-resort confirmation through the released web-search surface.
   *
   * Runs ONLY when `config.webSearch` is true, the Artificial Analysis lookup
   * failed outright, and no other layer produced a score. The single accepted
   * fact is a matching Artificial Analysis profile URL.
   *
   * ## Trust boundary
   *
   * Search output is untrusted input: a ranking can be poisoned, and a snippet
   * is attacker-influenced text. This function therefore never reads a number
   * out of a snippet, never follows an instruction found in one, and never
   * echoes snippet text into the tool result. It keeps only URLs whose parsed
   * host is `artificialanalysis.ai` (or a subdomain), which is the same content
   * `lib/aa/client.js` fetches directly — so the fallback adds no new authority,
   * it only re-locates a page the operator already trusts.
   *
   * @param {{ provider: string, model: string }} entry - route.
   * @param {any} exec - tool execution carrying the caller signal.
   * @returns {Promise<string|null>} an AA profile URL, or `null`.
   */
  async function readWebSearch(entry, exec) {
    if (webSearchEnabled !== true) return null
    const web = seams.web
    if (web === null || web === undefined || typeof web.search !== 'function') return null

    const query = `Artificial Analysis profile intelligence index for ${entry.provider} ${entry.model}`
    const search = Promise.resolve()
      .then(() => web.search({ query, maxResults: WEB_SEARCH_MAX_RESULTS }))
      .then((value) => value ?? null)
      .catch(() => null)
    // Same budget as every other lookup: one deadline, no retry, and the
    // caller's cancellation also stops this request.
    const answer = timeoutMs === null
      ? await search
      : await withDeadline(search, timeoutMs)
    if (answer === null || answer === undefined) return null

    const sources = Array.isArray(answer.sources) ? answer.sources : []
    for (const source of sources) {
      if (source === null || typeof source !== 'object') continue
      if (!isAaUrl(source.url)) continue
      const ok = exec?.signal?.aborted !== true
      if (!ok) return null
      debug(() => `web search confirmed an AA page for ${entry.provider}/${entry.model}`)
      return source.url
    }
    debug(() => `web search returned no artificialanalysis.ai source for ${entry.provider}/${entry.model}`)
    return null
  }

  /**
   * Copy advertised model metadata into detached routes.
   *
   * `llm.listModels()` returns detached `{ provider, id, name, ... }` entries.
   * Only an entry that names a usable model id is kept; the provider is taken
   * from the requested route unless the entry states the same one, so a
   * mislabelled entry can never be profiled as another provider's route.
   *
   * @param {unknown} models - `llm.listModels(provider)` result.
   * @param {string} provider - the requested provider id.
   * @returns {string[]} model ids, de-duplicated, in adapter order.
   */
  function modelIdsFromMetadata(models, provider) {
    if (!Array.isArray(models)) return []
    const ids = []
    const seen = new Set()
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      if (typeof model.id !== 'string' || model.id.length === 0) continue
      if (typeof model.provider === 'string' && model.provider.length > 0 && model.provider !== provider) continue
      if (seen.has(model.id)) continue
      seen.add(model.id)
      ids.push(model.id)
    }
    return ids
  }

  /**
   * Resolve the native `list_subagent_models` definition as the calling Session
   * sees it.
   *
   * @param {any} exec - tool execution carrying the caller agent.
   * @returns {any|null} the definition, or `null` when this context has none.
   */
  function nativeListingDefinition(exec) {
    const tools = safeService(ctx, 'tools')
    if (tools === null || typeof tools.get !== 'function') return null
    let definition = null
    try {
      definition = tools.get(NATIVE_TOOL_NAME, exec?.agent) ?? tools.get(NATIVE_TOOL_NAME)
    } catch {
      definition = null
    }
    if (definition === null || definition === undefined || typeof definition.execute !== 'function') return null
    return definition
  }

  /**
   * Read one provider's advertised models through the native listing surface.
   *
   * Last resort, used ONLY when no reachable host service exposes advertised
   * models. It invokes the resolved definition's own `execute` with
   * `{ provider }` — the native tool's models mode — so the answer is filtered
   * by the same durable Session policy as the call this handler is enriching.
   *
   * Calling the definition directly (rather than `tools.execute`) is deliberate:
   * it performs no dispatch, so it cannot re-enter this very waterfall and
   * cannot produce a nested enrichment or a second tool card. It also means the
   * definition's own throws (unknown provider, unsupported route, no reachable
   * `llm` service) reach the caller as a rejection, which the caller contains.
   *
   * @param {any} definition - resolved native listing definition.
   * @param {string} provider - bare provider id from the listing.
   * @param {any} exec - tool execution carrying the caller signal.
   * @returns {Promise<string[]>} advertised model ids, or `[]`.
   */
  async function readNativeModels(definition, provider, exec) {
    const answer = await definition.execute({ provider }, { signal: exec?.signal })
    if (typeof answer !== 'string' || answer.length === 0) return []
    const ids = []
    const seen = new Set()
    for (const model of parseModelList(answer)) {
      if (model.provider !== provider) continue
      if (seen.has(model.model)) continue
      seen.add(model.model)
      ids.push(model.model)
    }
    return ids
  }

  /**
   * Resolve one bare provider's advertised models, cheapest source first.
   *
   * 1. IN MEMORY — `llm.listModels(provider)`, the harness LLM service's own
   *    advertised-model catalogue. This is the exact call the native tool makes
   *    for `{ provider }`, and for the adapters mounted here it reads a local
   *    snapshot: no network, no second tool dispatch.
   * 2. NATIVE LISTING SURFACE — only when no host service exposes models (the
   *    `llm` service is absent from this context, or exposes no `listModels`).
   *
   * `gate.source` records which of the two was actually reachable, so the
   * caller can tell "no source exists in this context" apart from "a source
   * answered nothing". Never throws and never retries: a failure, an unusable
   * answer, or a deadline simply contributes no models, and an EMPTY catalogue
   * is a real answer that is not second-guessed through the more expensive
   * route.
   *
   * @param {string} provider - bare provider id from the listing.
   * @param {any} exec - tool execution carrying the caller signal.
   * @param {{ source: string|null }} gate - records the source that was reached.
   * @returns {Promise<string[]>} advertised model ids, or `[]`.
   */
  async function resolveProviderModels(provider, exec, gate) {
    const llm = currentLlm()
    if (llm !== null && typeof llm.listModels === 'function') {
      gate.source = 'llm'
      const ids = modelIdsFromMetadata(await llm.listModels(provider), provider)
      debug(() => `provider ${provider}: ${ids.length} advertised model(s) from the llm service`)
      return ids
    }
    const definition = nativeListingDefinition(exec)
    if (definition !== null) {
      gate.source = 'native'
      const ids = await readNativeModels(definition, provider, exec)
      debug(() => `provider ${provider}: ${ids.length} advertised model(s) from the native listing surface`)
      return ids
    }
    debug(() => `provider ${provider}: no advertised-model source is reachable in this context`)
    return []
  }

  /**
   * Resolve every distinct bare provider concurrently under ONE deadline.
   *
   * Bounded by construction: at most one lookup per distinct provider, all
   * lookups run concurrently, and each shares the same `config.timeoutMs`
   * budget as the rest of the enrichment (falling back to
   * {@link PROVIDER_MODEL_DEADLINE_MS} when the config sets none). A provider
   * that fails, rejects, times out or answers nothing maps to `[]`.
   *
   * When NO advertised-model source is reachable at all, the Session's own
   * authorized routes for that provider are used as the candidate set
   * (`fallbackByProvider`). That set is authorized by construction — this can
   * only ever profile a route the Session may really delegate to — and it is
   * the only remaining in-memory knowledge that names routes for a listed
   * provider, so the no-argument call still answers in a reduced context.
   *
   * @param {string[]} providers - bare provider ids from the listing.
   * @param {any} exec - tool execution carrying the caller signal.
   * @param {Map<string, string[]>} fallbackByProvider - authorized routes per provider.
   * @returns {Promise<Map<string, string[]>>} model ids per provider.
   */
  async function resolveProviders(providers, exec, fallbackByProvider) {
    const unique = []
    for (const provider of providers) {
      if (typeof provider === 'string' && provider.length > 0 && !unique.includes(provider)) unique.push(provider)
    }
    const gates = unique.map(() => ({ source: /** @type {string|null} */ (null) }))
    const budget = timeoutMs ?? PROVIDER_MODEL_DEADLINE_MS
    const settled = await Promise.all(
      unique.map((provider, index) => withDeadline(
        Promise.resolve().then(() => resolveProviderModels(provider, exec, gates[index])),
        budget,
      )),
    )
    const resolved = new Map()
    unique.forEach((provider, index) => {
      const ids = settled[index]
      if (Array.isArray(ids) && ids.length > 0) {
        resolved.set(provider, ids)
        return
      }
      // A source that WAS reachable and answered nothing (empty, failed, or
      // timed out) is trusted as the answer and never second-guessed.
      if (gates[index].source !== null) {
        resolved.set(provider, [])
        return
      }
      const fallback = fallbackByProvider instanceof Map ? fallbackByProvider.get(provider) : undefined
      if (Array.isArray(fallback) && fallback.length > 0) {
        resolved.set(provider, [...fallback])
        debug(() => `provider ${provider}: ${fallback.length} authorized route(s) used because no advertised-model source is reachable`)
        return
      }
      resolved.set(provider, [])
    })
    return resolved
  }

  /**
   * Enrich one authorized route into a profile block.
   *
   * @param {{ provider: string, model: string }} entry - authorized route.
   * @param {any} exec - tool execution.
   * @param {boolean} isSingle - whether the dossier layout is used.
   * @returns {Promise<string[]|null>} the block lines, or `null` when there is
   *   nothing worth appending.
   */
  async function buildBlock(entry, exec, isSingle) {
    const configured = resolveConfiguredProfile(cfg, entry.provider, entry.model)
    const skipRemote = configured !== null && configured.resolve === false
    let runtime = null
    let piAi = null
    let lookup = null
    let aaTimeoutMs = null
    if (!skipRemote) {
      const startedAt = Number(seams.now())
      const settled = await Promise.allSettled([
        readRuntime(entry, exec),
        readPiAi(entry),
        readAa(entry),
      ])
      const elapsed = Number(seams.now()) - startedAt
      runtime = settledValue(settled[0])
      piAi = settledValue(settled[1])
      lookup = settledValue(settled[2])
      if (lookup !== null && lookup.ok === false && lookup.reason === 'timeout') {
        aaTimeoutMs = msFromDetail(lookup.detail)
          ?? (Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : null)
          ?? timeoutMs
      }
    }
    const aaData = lookup !== null && lookup.ok === true ? lookup.data ?? null : null
    const aaReason = lookup !== null && lookup.ok === false
      ? (typeof lookup.reason === 'string' && lookup.reason.length > 0 ? lookup.reason : 'unavailable')
      : null
    let profile = mergeProfile({
      provider: entry.provider,
      model: entry.model,
      configured: configured === null ? null : configured.override,
      runtime,
      piAi,
      aa: aaData,
      aaReason,
      aaSourceUrl: lookup !== null && lookup.ok === true ? lookup.sourceUrl ?? null : null,
      aaFetchedAt: lookup !== null && lookup.ok === true ? lookup.fetchedAt ?? null : null,
    })
    // Last resort, and only when nothing else carried a score: the lookup
    // failed and neither the caller's profile, the runtime, pi-ai nor AA
    // supplied one. The search can locate an AA profile page; it never supplies
    // a number, so it cannot change any fact other than the source URL.
    if (
      !skipRemote
      && profile.sources.score === null
      && aaReason !== null
      && aaReason !== 'disabled'
      && aaReason !== 'offline'
    ) {
      const searchUrl = await readWebSearch(entry, exec)
      if (searchUrl !== null) profile = { ...profile, sourceUrl: searchUrl }
    }
    const lines = formatProfileLines(profile, {
      isSingle,
      showWhenToUse,
      includeAttribution,
      aaTimeoutMs,
    })
    if (lines.length === 0) return null
    debug(() => `enriched ${entry.provider}/${entry.model} (score=${profile.sources.score ?? 'none'}, price=${profile.sources.price ?? 'none'}, context=${profile.sources.context ?? 'none'})`)
    return lines
  }

  return async function handlePostExecute(exec, result, next) {
    const accept = () => (typeof next === 'function' ? next() : { kind: 'accept' })
    try {
      if (cfg.enabled === false) return await accept()
      if (exec === null || exec === undefined || exec.name !== NATIVE_TOOL_NAME) return await accept()
      if (result === null || result === undefined) return await accept()
      // Errors carry no catalogue to enrich, and must never be rewritten.
      if (result.isError === true) return await accept()
      const text = extractText(result.content)
      if (text.length === 0) return await accept()

      const mode = detectMode(exec.arguments)
      /**
       * Parsed listing lines. `model === null` marks a bare provider line,
       * whose advertised models still have to be resolved before it can become
       * a candidate route.
       */
      let lines = []
      if (mode === 'model') {
        const detail = parseModelDetail(text)
        if (detail !== null) lines = [{ provider: detail.provider, model: detail.model }]
      } else if (mode === 'models') {
        lines = parseModelList(text).map((model) => ({ provider: model.provider, model: model.model }))
      } else if (mode === 'providers') {
        // The no-argument call is the mode in which an Agent enumerates its
        // delegation routes, so it is enriched like a model listing: a line
        // that already names a model is used directly, and a bare provider line
        // (accepted by the same rule `parseProviderList` uses) is resolved to
        // the models the Session may delegate to.
        lines = parseProviderRoutes(text).map((line) => ({ provider: line.provider, model: line.model }))
      }
      if (lines.length === 0) {
        debug(() => `list_subagent_models: no enrichable lines (mode=${mode})`)
        return await accept()
      }

      const routes = await readRoutes(exec)
      // Unknown authorization must never be presented as authorized.
      if (!Array.isArray(routes) || routes.length === 0) {
        debug(() => `list_subagent_models: no authorized routes (${routes === undefined ? 'unknown' : 'empty'})`)
        return await accept()
      }

      const allowed = new Set()
      // Session knowledge that names routes per provider. Only the fallback of
      // {@link resolveProviders} reads it, and only when no advertised-model
      // source is reachable, so it can never widen what is profiled beyond the
      // routes this Session is already authorized to delegate to.
      const authorizedByProvider = new Map()
      for (const route of routes) {
        if (route === null || typeof route !== 'object') continue
        if (typeof route.provider !== 'string' || typeof route.model !== 'string') continue
        allowed.add(`${route.provider}\u0000${route.model}`)
        const models = authorizedByProvider.get(route.provider)
        if (models === undefined) authorizedByProvider.set(route.provider, [route.model])
        else if (!models.includes(route.model)) models.push(route.model)
      }

      // Bare providers are resolved once each, concurrently, under the same
      // `config.timeoutMs` deadline as every other lookup here. A provider that
      // fails, times out or returns nothing contributes no models — never an
      // error, never a throw, never a retry.
      const bareProviders = []
      for (const line of lines) {
        if (line.model === null && !bareProviders.includes(line.provider)) bareProviders.push(line.provider)
      }
      let resolvedModels = new Map()
      if (bareProviders.length > 0 && exec?.signal?.aborted !== true) {
        resolvedModels = await resolveProviders(bareProviders, exec, authorizedByProvider)
      }

      let annotated = text
      const authorized = []
      const queued = new Set()
      /**
       * Queue one candidate route when — and only when — the Session is
       * authorized to delegate to it.
       *
       * @param {string} provider - candidate provider.
       * @param {string} model - candidate model.
       * @returns {boolean} whether the route is authorized.
       */
      const queue = (provider, model) => {
        const routeKey = `${provider}\u0000${model}`
        if (!allowed.has(routeKey)) return false
        if (queued.has(routeKey)) return true
        queued.add(routeKey)
        authorized.push({ provider, model })
        return true
      }
      lines.forEach((line, index) => {
        // In detail mode the model line is line 0; in every list mode parsed
        // line i is line i, because a strict parse rejects any other line shape.
        const lineIndex = mode === 'model' ? 0 : index
        if (line.model !== null) {
          if (queue(line.provider, line.model)) return
          annotated = annotateLine(annotated, lineIndex, UNAUTHORIZED_SUFFIX)
          return
        }
        // A bare provider line names no route, so no per-route authorization
        // verdict can be attached to it: only the advertised models the Session
        // may delegate to are profiled, and the provider line itself stays
        // exactly as the native tool wrote it.
        for (const model of resolvedModels.get(line.provider) ?? []) queue(line.provider, model)
      })

      const isSingle = mode === 'model'
      const blocks = []
      for (const entry of authorized) {
        // Observe caller cancellation before starting more network work.
        if (exec?.signal?.aborted === true) {
          debug('list_subagent_models: caller cancelled before enrichment')
          return await accept()
        }
        const block = await buildBlock(entry, exec, isSingle)
        if (block !== null) blocks.push(block)
      }

      if (blocks.length === 0 && annotated === text) return await accept()
      const enriched = blocks.length === 0 ? annotated : `${annotated}\n\n${joinBlocks(blocks)}`
      return { kind: 'accept', content: rebuildContent(result.content, enriched) }
    } catch (error) {
      debug(() => `list_subagent_models: enrichment skipped after error: ${describeError(error)}`)
      return await accept()
    }
  }
}

/**
 * Read a millisecond budget out of a lookup failure detail.
 *
 * @param {unknown} detail - `lookup.detail`.
 * @returns {number|null} whole milliseconds, or `null`.
 */
function msFromDetail(detail) {
  if (typeof detail === 'number' && Number.isFinite(detail) && detail > 0) return Math.round(detail)
  if (typeof detail === 'string') {
    const match = /(\d+(?:\.\d+)?)\s*ms/i.exec(detail)
    if (match !== null) return Math.round(Number(match[1]))
  }
  return null
}

/**
 * Register the enrichment listener and finish optional setup.
 *
 * `ctx.on('tools/post-execute', ...)` runs SYNCHRONOUSLY, before this function's
 * first `await`, so the listener belongs to the plugin fiber immediately. The
 * returned promise then performs the optional Artificial Analysis setup step
 * and resolves once setup is finished; that step can never reject, so it cannot
 * fail activation.
 *
 * When the config names a snapshot/index artifact, setup creates the ONE shared
 * AA client and reads `indexStatus()`. Two honest limits apply and are recorded
 * here rather than hidden: `createAaClient` performs no I/O, and `indexStatus()`
 * never fetches (verified in `lib/aa/client.js`), so the snapshot itself is
 * still read lazily by the shared client on the first lookup and cached
 * afterwards. Activation therefore never performs network I/O, and the client
 * memo is what makes the snapshot, the index and every lookup cache shared
 * across all later calls.
 *
 * @param {any} ctx - plugin context.
 * @param {any} config - normalized plugin config.
 * @returns {Promise<{ dispose: () => void }>} resolves when setup finished.
 */
export function install(ctx, config) {
  const cfg = config ?? {}
  const log = debugLogger(ctx, cfg)

  // install owns the client memo so the setup-time step and the listener share
  // one snapshot, one index and one lookup cache.
  let client = null
  const sharedFactory = (options) => {
    if (client === null) client = defaultCreateAaClient(options)
    return client
  }

  const handler = createEnricher(ctx, cfg, { createAaClient: sharedFactory })
  try {
    ctx.on('tools/post-execute', (exec, result, next) => handler(exec, result, next))
  } catch (error) {
    // A registry that cannot accept the listener leaves nothing to enrich, so
    // the plugin degrades to "no enrichment" and reports once instead of
    // failing the whole boot; the entry module documents that contract.
    try {
      ctx?.logger?.error?.(`[better-subagents] could not register the tools/post-execute listener: ${describeError(error)}`)
    } catch {
      // Nothing left to report through.
    }
    return Promise.resolve({ dispose() {} })
  }

  return (async () => {
    try {
      const aaDisabled = cfg.enabled === false
        || (cfg.aa !== null && typeof cfg.aa === 'object' && cfg.aa.enabled === false)
      if (!aaDisabled && snapshotConfigured(cfg)) {
        const warm = sharedFactory({ config: cfg, ctx })
        if (warm !== null && warm !== undefined && typeof warm.indexStatus === 'function') {
          const deadline = typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
            ? cfg.timeoutMs
            : SETUP_DEADLINE_MS
          const status = await withDeadline(Promise.resolve(warm.indexStatus()), deadline)
          if (status !== null && typeof status === 'object') {
            log(`aa setup: index loaded=${status.loaded === true}, tier=${status.tier ?? 'none'}, generatedAt=${status.generatedAt ?? 'none'}, error=${status.error ?? 'none'}`)
          }
        }
      }
    } catch (error) {
      log(`aa snapshot warm-up skipped: ${describeError(error)}`)
    }
    return {
      /**
       * Drop this install's memo reference to the Artificial Analysis client.
       * The listener is owned by `ctx.on` on the plugin fiber, so stopping the
       * plugin removes the hook and releases everything the enricher closure
       * holds; no external resource is retained here.
       */
      dispose() {
        client = null
      },
    }
  })()
}

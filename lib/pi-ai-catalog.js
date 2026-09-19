/**
 * pi-ai catalogue bridge — the plugin's only source of real USD token prices.
 *
 * The harness LLM seam exposes no cost field at all (verified), so the pi-ai
 * model catalogue bundled with the deployment is used as the authoritative
 * price/context source. It is read strictly read-only, and no state of the
 * catalogue is ever mutated.
 *
 * Resolution is deliberately tolerant, because the plugin can be installed in
 * more than one shape:
 *
 *   1. the bare specifier `@earendil-works/pi-ai/providers/all`, resolved by
 *      Node from *this file's real path*. That works when the plugin is a real
 *      directory under `$DSH_HOME/profiles/<name>/node_modules` (Node realpaths
 *      symlinks, so a `link:` install misses here and falls through);
 *   2. the same file at `$DSH_HOME/profiles/node_modules/@earendil-works/pi-ai/
 *      dist/providers/all.js`, the hoisted location `dsh plugin add`
 *      materialises shared dependencies into;
 *   3. neither — the plugin then reports every other fact it has and simply
 *      loses prices, which is why every failure below is swallowed.
 *
 * A failed resolution is deliberately never inspected and never printed:
 * "pi-ai is not installed here" and "the install is broken" mean the same thing
 * to every caller (both are `null`), this module owns no logger, a host plugin
 * writing to stdout/stderr is noise, and the caller's `debugLog` decides
 * whether the degradation is worth reporting. The settled outcome — success or
 * failure — is cached for the life of the process.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The catalogue entry point, as published by pi-ai's `./providers/*` export. */
const BARE_SPECIFIER = '@earendil-works/pi-ai/providers/all'

/** Where the hoisted profile-level install keeps the same file. */
const HOISTED_SEGMENTS = [
  'profiles',
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'all.js',
]

/** A trailing build stamp: `-0731`, `-20250731` or `-20250731-02`. */
const TRAILING_DATE_RE = /-(?:\d{8}|\d{4}(?:-\d{2})?)$/

/** Promise of the settled module namespace (or `null`); `null` until first use. */
let piAiModule = null

/**
 * Drop the cached resolution so a test can observe a different `DSH_HOME`.
 * Not part of the plugin's runtime surface.
 */
export function resetPiAiCacheForTests() {
  piAiModule = null
}

/**
 * The deployment home, used for the hoisted fallback path.
 *
 * @returns {string} `$DSH_HOME` when it is set to something non-empty,
 *   otherwise `<homedir>/.dsh` — the same default the CLI uses.
 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

/**
 * Load the pi-ai catalogue module.
 *
 * @returns {Promise<object|null>} The module namespace, or `null` when neither
 *   resolution strategy works. The outcome is cached: repeated calls do not
 *   re-import, and a failure is not retried.
 */
export async function loadPiAi() {
  if (piAiModule === null) piAiModule = resolvePiAi()
  return piAiModule
}

async function resolvePiAi() {
  const bare = await tryImport(BARE_SPECIFIER)
  if (bare !== null) return bare

  let specifier = ''
  try {
    specifier = pathToFileURL(join(dshHome(), ...HOISTED_SEGMENTS)).href
  } catch {
    return null
  }
  return tryImport(specifier)
}

async function tryImport(specifier) {
  try {
    return await import(specifier)
  } catch {
    // Both "not installed here" and "installed but broken" mean the same thing
    // to every caller, so they take the same path. See the module doc for why
    // nothing is logged.
    return null
  }
}

/**
 * Read the authoritative facts for one provider route + model id.
 *
 * Provider keys in this deployment's harness routes do not always equal pi-ai
 * provider keys (`qwen-token-plan-cn` is a route, while pi-ai ships both
 * `qwen-token-plan-cn` and `qwen-token-plan`), so the lookup walks outwards:
 * the exact route, the route without a `-cn` suffix, then every catalogue key
 * in a prefix relationship with the route — each of them tried with the exact
 * model id and with a trailing date stamp removed.
 *
 * Never throws and never logs; `null` means "no catalogue record found", which
 * the caller renders as "prices unavailable". Each probe is individually
 * guarded: a catalogue that throws for an unknown provider or model (instead of
 * returning `undefined`) or that cannot list its providers must not cost the
 * candidate that would have answered.
 *
 * @param {string} provider Harness provider route, e.g. `qwen-token-plan-cn`.
 * @param {string} model Model id inside that route, e.g. `qwen3.8-flash`.
 * @returns {Promise<{source: 'pi-ai', cost: {input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null}|null, contextWindow: number|null, maxTokens: number|null}|null>}
 *   Facts in USD per 1M tokens, or `null` when the catalogue has no record.
 */
export async function readPiAiFacts(provider, model) {
  try {
    const piAi = await loadPiAi()
    if (!isRecord(piAi)) return null
    const getModel = piAi.getBuiltinModel
    if (typeof getModel !== 'function') return null

    const modelId = typeof model === 'string' ? model.trim() : ''
    if (modelId === '') return null
    const route = typeof provider === 'string' ? provider.trim() : ''

    const providerKeys = readProviderKeys(piAi)

    for (const key of providerCandidates(route, providerKeys)) {
      for (const candidate of modelCandidates(modelId)) {
        const record = safeGetModel(getModel, piAi, key, candidate)
        if (isRecord(record)) return factsOf(record)
      }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Read the catalogue's provider key list, tolerating a catalogue that refuses
 * to list them.
 *
 * A failure here only costs the extra prefix candidates: the explicit route is
 * still probed, so the outcome degrades to "fewer guesses", never to "no facts".
 *
 * @param {any} piAi Catalogue module namespace.
 * @returns {string[]} Provider keys, or `[]` when they are unavailable.
 */
function readProviderKeys(piAi) {
  if (typeof piAi.getBuiltinProviders !== 'function') return []
  try {
    return toStringList(piAi.getBuiltinProviders())
  } catch {
    return []
  }
}

/**
 * One catalogue lookup that cannot abort the candidate walk.
 *
 * A catalogue that throws for an unknown provider or model — instead of
 * returning `undefined` — must not cost the routes that would have answered, so
 * a throwing probe counts as "no record" and the walk continues.
 *
 * @param {Function} getModel `piAi.getBuiltinModel`.
 * @param {any} thisArg Catalogue module namespace.
 * @param {string} provider Candidate provider key.
 * @param {string} model Candidate model id.
 * @returns {any} The record, or `null` when this probe cannot answer.
 */
function safeGetModel(getModel, thisArg, provider, model) {
  try {
    return getModel.call(thisArg, provider, model)
  } catch {
    return null
  }
}

/**
 * Catalogue provider keys to try, closest name first, de-duplicated.
 *
 * @param {string} route Harness provider route.
 * @param {string[]} providers Keys reported by `getBuiltinProviders()`.
 * @returns {string[]} Ordered candidate keys.
 */
function providerCandidates(route, providers) {
  const out = []
  const seen = new Set()
  const push = (key) => {
    if (typeof key !== 'string') return
    const trimmed = key.trim()
    if (trimmed === '' || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  push(route)
  if (route.endsWith('-cn')) push(route.slice(0, -'-cn'.length))

  const exact = []
  const variants = [] // catalogue key extends the route: `route-something`
  const parents = [] // route extends the catalogue key: `key-something`
  for (const key of providers) {
    if (key === route) exact.push(key)
    else if (route !== '' && key.startsWith(`${route}-`)) variants.push(key)
    else if (route !== '' && route.startsWith(`${key}-`)) parents.push(key)
  }
  // For a route with sub-variants the shortest key is the one the route names;
  // for a sub-route the longest key shares the most name with it.
  variants.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
  parents.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))

  for (const key of exact) push(key)
  for (const key of variants) push(key)
  for (const key of parents) push(key)
  return out
}

/**
 * Model ids to try inside one provider: the id itself, then the same id with a
 * trailing date stamp removed (`kimi-k2-0905` -> `kimi-k2`).
 *
 * @param {string} modelId Model id.
 * @returns {string[]} One or two candidates, exact id first.
 */
function modelCandidates(modelId) {
  const stripped = modelId.replace(TRAILING_DATE_RE, '')
  return stripped !== '' && stripped !== modelId ? [modelId, stripped] : [modelId]
}

/**
 * Shape one catalogue record into the plugin's own facts object. Only leaf
 * fields are copied: the record itself belongs to the catalogue.
 *
 * @param {Record<string, unknown>} record pi-ai model record.
 * @returns {{source: 'pi-ai', cost: object|null, contextWindow: number|null, maxTokens: number|null}}
 */
function factsOf(record) {
  return {
    source: 'pi-ai',
    cost: readCost(record.cost),
    contextWindow: finiteOrNull(record.contextWindow),
    maxTokens: finiteOrNull(record.maxTokens),
  }
}

/**
 * @param {unknown} cost pi-ai `cost` field, in USD per 1M tokens.
 * @returns {{input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null}|null}
 *   The four rates, `null` for any that is not a finite number, or `null` when
 *   the record carries no cost object at all.
 */
function readCost(cost) {
  if (!isRecord(cost)) return null
  return {
    input: finiteOrNull(cost.input),
    output: finiteOrNull(cost.output),
    cacheRead: finiteOrNull(cost.cacheRead),
    cacheWrite: finiteOrNull(cost.cacheWrite),
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value) {
  return value !== null && typeof value === 'object'
}

function toStringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string')
}

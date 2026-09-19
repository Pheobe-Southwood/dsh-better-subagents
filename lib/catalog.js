/**
 * Configured-profile resolution, multi-source merging, and model-facing
 * rendering for the enrichment block appended to `list_subagent_models`.
 *
 * ## Sources and precedence
 *
 * Four layers can describe one `provider/model` route. The renderer never
 * invents a value: a field that no layer supplies stays `null` and is omitted.
 *
 * 1. `configured` — the user override at `config.profiles['provider/model']`.
 *    An explicit user statement about THEIR deployment wins over every
 *    inferred value, so it is applied last for every field it sets.
 * 2. `runtime` — facts from the harness LLM service (`resolveModelInfo`):
 *    `contextWindow`, `defaultMaxTokens`, `reasoning`, `name`,
 *    `inputModalities`. The runtime `contextWindow` is the value the adapter
 *    will actually use, so it always beats the Artificial Analysis and pi-ai
 *    context windows.
 * 3. `piAi` — USD rates from the bundled pi-ai catalogue, plus max-token
 *    metadata and a context-window fallback. Its rates are keyed by the exact
 *    local route, while an Artificial Analysis match can be an
 *    alias/exact/snapshot resolution, so the local rate wins when both are
 *    present. Its context window is the WEAKEST context layer: the catalogue
 *    describes the upstream model rather than this deployment's adapter
 *    (1,000,000 for a route the adapter reports at 272,000), so it is used only
 *    when the runtime and Artificial Analysis are both silent, and the renderer
 *    labels it `(pi-ai catalogue)`. Only a `runtime` or `configured` context
 *    window is printed bare, as the operational limit.
 * 4. `aa` — Artificial Analysis: the authoritative source for score, speed,
 *    latency, rank and the display name; its measured context window is used
 *    above the pi-ai catalogue and marked approximate, while price stays below
 *    pi-ai's exact local rate.
 *
 * Open decision (recorded for review): the plan's layer list reads "later
 * overrides earlier" (which would make `aa` strongest), while the per-layer
 * prose calls `piAi` the USD-rate source and AA's context/price "a last
 * resort". The per-field prose is the more specific instruction and matches the
 * subscription-route use case (`allZeroCost`), so this module implements
 * "configured wins, then the field's owning source" and keeps AA's price below
 * pi-ai's. {@link pickStrongest} is the single place to change that order. The
 * context window is the one exception, and for the same reason the prose gives:
 * the pi-ai catalogue names a figure this deployment's adapter does not enforce
 * (1,000,000 vs 272,000 measured), so AA's measured, explicitly approximate
 * figure outranks it. No renderer change is needed to revisit that choice —
 * swapping the first two candidates above is the whole change.
 *
 * ## `allZeroCost`
 *
 * `allZeroCost` is `true` only when a price layer is actually present AND every
 * one of `input`/`output`/`cacheRead` is exactly `0`. The renderer turns that
 * into `subscription route (catalogue rate 0)` and NEVER into `$0.00` or
 * "free": an all-zero catalogue rate is a plan artifact, not a claim that a
 * request costs nothing, and a partly-known rate (for example a `null`
 * `cacheRead`) must stay numeric rather than be advertised as free.
 *
 * @module dsh-better-subagents/catalog
 */

import { normalizeModelId } from './model-id.js'

/** Separator the native listing uses between route id and display name. */
const SEPARATOR = ' \u2014 '

/** Attribution line required whenever AA data is rendered. */
const AA_ATTRIBUTION = 'Source: Artificial Analysis (artificialanalysis.ai)'

/** Placeholder identity used only when a profile carries no route and no name. */
const UNKNOWN_ROUTE = 'unknown route'

/**
 * Whether a value is a non-null, non-array object.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} whether the value can carry named fields.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a finite, non-negative number field.
 *
 * @param {unknown} value - candidate value.
 * @returns {number|null} the number, or `null` when it is not a usable value.
 */
function numberOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Read the first usable string field among `keys`.
 *
 * @param {any} source - object to read.
 * @param {string[]} keys - candidate field names, in priority order.
 * @returns {string|null} the first non-empty string, or `null`.
 */
function strOf(source, keys) {
  if (!isPlainObject(source)) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Read the first usable number field among `keys`.
 *
 * @param {any} source - object to read.
 * @param {string[]} keys - candidate field names, in priority order.
 * @returns {number|null} the first usable number, or `null`.
 */
function numOf(source, keys) {
  if (!isPlainObject(source)) return null
  for (const key of keys) {
    const value = numberOrNull(source[key])
    if (value !== null) return value
  }
  return null
}

/**
 * Read one object field.
 *
 * @param {any} source - object to read.
 * @param {string[]} keys - candidate field names, in priority order.
 * @returns {any|null} the first object value, or `null`.
 */
function objOf(source, keys) {
  if (!isPlainObject(source)) return null
  for (const key of keys) {
    if (isPlainObject(source[key])) return source[key]
  }
  return null
}

/**
 * Normalize a rate object to the profile's price shape.
 *
 * @param {unknown} source - `pricePer1M`, pi-ai `cost`, or a configured rate.
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null }|null}
 *   the normalized rate, or `null` when no dimension is known.
 */
function normalizePrice(source) {
  if (!isPlainObject(source)) return null
  const input = numberOrNull(source.input)
  const output = numberOrNull(source.output)
  const cacheRead = numberOrNull(source.cacheRead)
  if (input === null && output === null && cacheRead === null) return null
  return { input, output, cacheRead }
}

/**
 * Normalize the configured price layer.
 *
 * Accepts both the merged-profile shape (`pricePer1M: { input, output,
 * cacheRead }`) and the hand-written config shape declared by
 * `lib/index-config.js` (`inputPer1M`, `outputPer1M`, `cacheReadPer1M`), so a
 * user override lands on the same fields either way.
 *
 * @param {any} configured - the configured layer, possibly `null`.
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null }|null}
 *   the configured rate, or `null` when the override sets none.
 */
function configuredPrice(configured) {
  if (!isPlainObject(configured)) return null
  const nested = normalizePrice(configured.pricePer1M ?? configured.cost ?? configured.price)
  if (nested !== null) return nested
  const input = numberOrNull(configured.inputPer1M)
  const output = numberOrNull(configured.outputPer1M)
  const cacheRead = numberOrNull(configured.cacheReadPer1M)
  if (input === null && output === null && cacheRead === null) return null
  return { input, output, cacheRead }
}

/**
 * Choose the strongest candidate from a weakest-to-strongest list.
 *
 * @param {{ origin: string, value: any }[]} candidates - ordered candidates.
 * @returns {{ origin: string, value: any }|null} the strongest present
 *   candidate, or `null` when none is present.
 */
function pickStrongest(candidates) {
  let winner = null
  for (const candidate of candidates) {
    if (candidate.value === null || candidate.value === undefined) continue
    winner = candidate
  }
  return winner
}

/**
 * Normalize a comparison key: lowercase, alphanumerics only.
 *
 * @param {string} value - raw key text.
 * @returns {string} the normalized key.
 */
function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Canonicalize a model id for profile-key comparison, never throwing.
 *
 * @param {unknown} value - candidate model id or profile key.
 * @returns {string} the canonical id, or `''` when it cannot be normalized.
 */
function safeNormalizeModelId(value) {
  try {
    return normalizeModelId(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Extract the headline index value from an Artificial Analysis score payload.
 *
 * The lookup may report `scores` as the headline number or as a map of index
 * values. Resolution order is deterministic: the exact `scoreName` key, a
 * normalized `scoreName` key, the first key mentioning "intelligence", then the
 * first numeric value in insertion order.
 *
 * @param {unknown} scores - `aa.scores`.
 * @param {unknown} scoreName - `aa.scoreName`.
 * @returns {number|null} the headline score, or `null` when none is known.
 */
function headlineScore(scores, scoreName) {
  const direct = numberOrNull(scores)
  if (direct !== null) return direct
  if (!isPlainObject(scores)) return null
  const keys = Object.keys(scores)
  if (keys.length === 0) return null
  const name = typeof scoreName === 'string' && scoreName.length > 0 ? scoreName : null
  if (name !== null) {
    const exact = numberOrNull(scores[name])
    if (exact !== null) return exact
    const normalized = normalizeKey(name)
    for (const key of keys) {
      if (normalizeKey(key) !== normalized) continue
      const value = numberOrNull(scores[key])
      if (value !== null) return value
    }
  }
  for (const key of keys) {
    if (!/intelligence/i.test(key)) continue
    const value = numberOrNull(scores[key])
    if (value !== null) return value
  }
  for (const key of keys) {
    const value = numberOrNull(scores[key])
    if (value !== null) return value
  }
  return null
}

/**
 * Copy the runtime reasoning description into an owned plain object.
 *
 * The LLM service value is live adapter state; only the leaf fields the
 * renderer needs are copied.
 *
 * @param {unknown} source - `runtime.reasoning` or a configured equivalent.
 * @returns {{ efforts: { id: string, name: string|null, description: string|null }[], defaultEffort: string|null }|null}
 *   the copied reasoning info, or `null` when nothing is known.
 */
function normalizeReasoning(source) {
  const real = objOf(source, ['reasoning', 'reasoningInfo'])
  const raw = real ?? (isPlainObject(source) ? source : null)
  if (raw === null) return null
  const efforts = []
  if (Array.isArray(raw.efforts)) {
    for (const effort of raw.efforts) {
      if (!isPlainObject(effort)) continue
      const id = strOf(effort, ['id'])
      if (id === null) continue
      efforts.push({ id, name: strOf(effort, ['name']), description: strOf(effort, ['description']) })
    }
  }
  const defaultEffort = strOf(raw, ['defaultEffort'])
  if (efforts.length === 0 && defaultEffort === null) return null
  return { efforts, defaultEffort }
}

/**
 * Copy an input-modality list into an owned `string[]`.
 *
 * @param {unknown} source - `runtime.inputModalities` or a configured list.
 * @returns {string[]|null} the copied modalities, or `null` when none are known.
 */
function normalizeModalities(source) {
  if (!Array.isArray(source)) return null
  const copied = []
  for (const modality of source) {
    if (typeof modality !== 'string' || modality.length === 0) continue
    copied.push(modality)
  }
  return copied.length === 0 ? null : copied
}

/**
 * Split a `'provider/model'` profile key.
 *
 * The split is on the FIRST `/`, because provider ids never contain one while
 * model ids may (for example `meta-llama/Llama-3.1-70B`).
 *
 * @param {unknown} key - raw key.
 * @returns {{ provider: string, model: string }|null} the split key, or `null`.
 */
export function parseProfilesKey(key) {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  const at = trimmed.indexOf('/')
  if (at <= 0 || at === trimmed.length - 1) return null
  const provider = trimmed.slice(0, at)
  const model = trimmed.slice(at + 1)
  if (provider.length === 0 || model.length === 0) return null
  return { provider, model }
}

/**
 * Read one profile override entry from the configured profiles map.
 *
 * Accepted shapes, in order: a plain record keyed by `'provider/model'`, a
 * `Map` with the same keys, any record whose keys normalize to the requested
 * route, and a nested `profiles[provider][model]` record.
 *
 * @param {unknown} profiles - `config.profiles`.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {unknown} the raw override entry, or `null` when none applies.
 */
function lookupProfileEntry(profiles, provider, model) {
  if (profiles === null || profiles === undefined) return null
  const key = `${provider}/${model}`
  if (profiles instanceof Map) {
    if (profiles.has(key)) {
      const value = profiles.get(key)
      return value === undefined ? null : value
    }
  } else if (isPlainObject(profiles)) {
    if (Object.prototype.hasOwnProperty.call(profiles, key)) {
      const value = profiles[key]
      return value === undefined ? null : value
    }
  }
  const entries = profiles instanceof Map
    ? [...profiles.entries()]
    : isPlainObject(profiles)
      ? Object.entries(profiles)
      : []
  for (const [entryKey, entryValue] of entries) {
    const parsed = parseProfilesKey(entryKey)
    if (parsed === null) continue
    if (parsed.provider !== provider || parsed.model !== model) continue
    if (entryValue === undefined) continue
    return entryValue
  }
  // The config contract accepts a bare model id (or AA slug) as a profile key
  // in addition to `'provider/model'`, so a key with no `/` is compared by
  // normalized model id. Route-shaped keys are deliberately NOT considered here
  // — they were handled above — so an override written for one provider's route
  // can never leak onto another provider that happens to use the same model id.
  const normalizedModel = safeNormalizeModelId(model)
  if (normalizedModel !== '') {
    for (const [entryKey, entryValue] of entries) {
      if (entryKey.includes('/')) continue
      if (entryValue === undefined || entryValue === null) continue
      if (entryKey === model) return entryValue
      if (safeNormalizeModelId(entryKey) === normalizedModel) return entryValue
    }
  }
  if (isPlainObject(profiles)) {
    const nested = profiles[provider]
    if (isPlainObject(nested) && Object.prototype.hasOwnProperty.call(nested, model)) {
      const value = nested[model]
      if (value !== undefined) return value
    }
  }
  return null
}

/**
 * Resolve the user override that applies to one route.
 *
 * The returned `override` is a detached copy of the configured entry and is the
 * `configured` layer for {@link mergeProfile}. When `resolve` is `false` —
 * because this entry sets `resolve: false` or the plugin config disables
 * resolution globally — the caller MUST skip every network and pi-ai lookup for
 * this route and merge only the configured and runtime facts.
 *
 * @param {any} config - normalized plugin config.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {{ provider: string, model: string, resolve: boolean, override: Record<string, unknown> }|null}
 *   the override handle, or `null` when this route has no override.
 */
export function resolveConfiguredProfile(config, provider, model) {
  try {
    if (typeof provider !== 'string' || provider.length === 0) return null
    if (typeof model !== 'string' || model.length === 0) return null
    const entry = lookupProfileEntry(config?.profiles, provider, model)
    if (!isPlainObject(entry)) return null
    const override = { ...entry }
    const resolve = override.resolve === false || config?.resolve === false ? false : true
    return { provider, model, resolve, override }
  } catch {
    return null
  }
}

/**
 * Merge the four fact layers into one renderable profile.
 *
 * Every field of the result is nullable; `sources` records which layer owned
 * each field group. The function is total: unknown or malformed layers degrade
 * to `null` fields instead of throwing.
 *
 * @param {{
 *   provider?: unknown, model?: unknown,
 *   configured?: any, runtime?: any, piAi?: any, aa?: any,
 *   aaReason?: unknown, aaSourceUrl?: unknown, aaFetchedAt?: unknown,
 * }} layers - fact layers; `aa` may be the lookup data, the whole lookup
 *   envelope (`{ ok, data, ... }`), or `null`.
 * @returns {{
 *   provider: string|null, model: string|null,
 *   rawName: string|null,
 *   scores: number|null, scoreName: string|null, scoreVersion: string|null,
 *   rank: number|null, ofCount: number|null,
 *   pricePer1M: { input: number|null, output: number|null, cacheRead: number|null },
 *   priceOrigin: 'aa'|'pi-ai'|'config'|null,
 *   contextWindow: number|null, contextOrigin: 'runtime'|'aa'|'pi-ai'|'config'|null,
 *   maxTokens: number|null,
 *   tokensPerSecond: number|null, timeToFirstAnswerTokenSeconds: number|null,
 *   reasoning: { efforts: { id: string, name: string|null, description: string|null }[], defaultEffort: string|null }|null,
 *   inputModalities: string[]|null,
 *   aliasOf: string|null,
 *   sourceUrl: string|null, generatedAt: string|null, fetchedAt: string|null,
 *   sourceOrigin: string|null,
 *   aaReason: string|null,
 *   note: string|null, whenToUse: string|null, whenNotTo: string|null,
 *   allZeroCost: boolean,
 *   sources: { score: 'aa'|'config'|null, price: 'aa'|'pi-ai'|'config'|null, context: 'runtime'|'aa'|'pi-ai'|'config'|null, speed: 'aa'|'config'|null },
 * }} the merged profile.
 */
export function mergeProfile(layers) {
  const input = isPlainObject(layers) ? layers : {}
  const provider = strOf(input, ['provider'])
  const model = strOf(input, ['model'])
  const configured = objOf(input, ['configured'])
  const runtime = objOf(input, ['runtime'])
  const piAi = objOf(input, ['piAi'])

  let aa = objOf(input, ['aa'])
  let aaReason = strOf(input, ['aaReason'])
  let aaSourceUrl = strOf(input, ['aaSourceUrl'])
  let aaFetchedAt = strOf(input, ['aaFetchedAt'])
  if (aa !== null && aa.ok === false) {
    aaReason = aaReason ?? strOf(aa, ['reason'])
    aa = null
  } else if (aa !== null && aa.ok === true) {
    aaSourceUrl = aaSourceUrl ?? strOf(aa, ['sourceUrl'])
    aaFetchedAt = aaFetchedAt ?? strOf(aa, ['fetchedAt'])
    aa = objOf(aa, ['data'])
  }
  if (aa !== null) aaReason = null

  // --- display name: configured > AA > runtime -----------------------------
  const rawName = pickStrongest([
    { origin: 'runtime', value: strOf(runtime, ['name']) },
    { origin: 'aa', value: aa === null ? null : strOf(aa, ['rawName', 'name']) },
    { origin: 'config', value: strOf(configured, ['rawName', 'name']) },
  ])?.value ?? null

  // --- score group: configured > AA ---------------------------------------
  const aaScore = aa === null ? null : headlineScore(aa.scores, aa.scoreName)
  const configuredScore = configured === null
    ? null
    : numOf(configured, ['score']) ?? headlineScore(configured.scores, configured.scoreName)
  const scorePick = pickStrongest([
    { origin: 'aa', value: aaScore },
    { origin: 'config', value: configuredScore },
  ])
  const scoreLayer = scorePick?.origin === 'aa' ? aa : scorePick?.origin === 'config' ? configured : null
  const scores = scorePick?.value ?? null
  const scoreName = scoreLayer === null ? null : strOf(scoreLayer, ['scoreName'])
  const scoreVersion = scoreLayer === null ? null : strOf(scoreLayer, ['scoreVersion'])
  const rank = pickStrongest([
    { origin: 'aa', value: aa === null ? null : numOf(aa, ['rank']) },
    { origin: 'config', value: numOf(configured, ['rank']) },
  ])?.value ?? null
  const ofCount = pickStrongest([
    { origin: 'aa', value: aa === null ? null : numOf(aa, ['ofCount']) },
    { origin: 'config', value: numOf(configured, ['ofCount']) },
  ])?.value ?? null

  // --- price: configured > pi-ai > AA -------------------------------------
  const pricePick = pickStrongest([
    { origin: 'aa', value: aa === null ? null : normalizePrice(aa.pricePer1M) },
    { origin: 'pi-ai', value: piAi === null ? null : normalizePrice(piAi.cost ?? piAi.pricePer1M) },
    { origin: 'config', value: configuredPrice(configured) },
  ])
  const pricePer1M = pricePick?.value ?? { input: null, output: null, cacheRead: null }
  const priceOrigin = pricePick?.origin ?? null
  const allZeroCost = priceOrigin !== null
    && pricePer1M.input === 0
    && pricePer1M.output === 0
    && pricePer1M.cacheRead === 0

  // --- context: configured > runtime > AA > pi-ai --------------------------
  // pickStrongest keeps the LAST present candidate, so the array runs
  // weakest-to-strongest. The runtime `contextWindow` is the value this
  // deployment's adapter will actually enforce, so it outranks everything; the
  // pi-ai catalogue is the weakest layer of all, because it describes the
  // upstream model rather than the deployed route (the live Qwen route is
  // catalogued at 1,000,000 while the adapter enforces 272,000). AA's measured
  // figure is closer to that operational reality than the catalogue, and it is
  // rendered as an approximation, so it sits above the catalogue and below the
  // runtime. The renderer states each origin, so a catalogue value is never
  // mistaken for the enforced limit.
  const contextPick = pickStrongest([
    { origin: 'pi-ai', value: piAi === null ? null : numOf(piAi, ['contextWindow', 'context']) },
    { origin: 'aa', value: aa === null ? null : numOf(aa, ['contextWindow']) },
    { origin: 'runtime', value: runtime === null ? null : numOf(runtime.context, ['contextWindow']) ?? numOf(runtime, ['contextWindow']) },
    { origin: 'config', value: configured === null ? null : numOf(configured, ['contextWindow']) ?? numOf(configured.context, ['contextWindow']) },
  ])
  const contextWindow = contextPick?.value ?? null
  const contextOrigin = contextPick?.origin ?? null

  // --- max output: configured > runtime > pi-ai ---------------------------
  // Same weakest-to-strongest rule as the context window above.
  const maxTokens = pickStrongest([
    { origin: 'pi-ai', value: piAi === null ? null : numOf(piAi, ['maxTokens']) },
    { origin: 'runtime', value: runtime === null ? null : numOf(runtime, ['defaultMaxTokens', 'maxTokens']) },
    { origin: 'config', value: configured === null ? null : numOf(configured, ['maxTokens', 'defaultMaxTokens']) },
  ])?.value ?? null

  // --- speed group: configured > AA ---------------------------------------
  const speedPick = pickStrongest([
    { origin: 'aa', value: aa === null ? null : numOf(aa, ['tokensPerSecond']) },
    { origin: 'config', value: configured === null ? null : numOf(configured, ['tokensPerSecond', 'speed']) },
  ])
  const tokensPerSecond = speedPick?.value ?? null
  const latencyPick = pickStrongest([
    { origin: 'aa', value: aa === null ? null : numOf(aa, ['timeToFirstAnswerTokenSeconds']) },
    {
      origin: 'config',
      value: configured === null
        ? null
        : numOf(configured, ['timeToFirstAnswerTokenSeconds', 'ttft']),
    },
  ])
  const timeToFirstAnswerTokenSeconds = latencyPick?.value ?? null

  // --- runtime-owned pass-throughs ----------------------------------------
  const reasoning = normalizeReasoning(
    configured === null ? runtime?.reasoning : configured.reasoning ?? configured.reasoningEfforts ?? runtime?.reasoning,
  )
  const inputModalities = normalizeModalities(
    configured === null ? runtime?.inputModalities : configured.inputModalities ?? runtime?.inputModalities,
  )

  // --- AA identity and provenance -----------------------------------------
  const aaSlug = aa === null ? null : strOf(aa, ['slug'])
  const aliasOf = strOf(configured, ['aliasOf', 'alias'])
    ?? (aaSlug !== null && aaSlug !== model ? aaSlug : null)

  return {
    provider,
    model,
    rawName,
    scores,
    scoreName,
    scoreVersion,
    rank,
    ofCount,
    pricePer1M,
    priceOrigin,
    contextWindow,
    contextOrigin,
    maxTokens,
    tokensPerSecond,
    timeToFirstAnswerTokenSeconds,
    reasoning,
    inputModalities,
    aliasOf,
    sourceUrl: aaSourceUrl ?? (aa === null ? null : strOf(aa, ['sourceUrl'])) ?? strOf(configured, ['sourceUrl']),
    generatedAt: (aa === null ? null : strOf(aa, ['generatedAt'])) ?? strOf(configured, ['generatedAt']),
    fetchedAt: aaFetchedAt ?? (aa === null ? null : strOf(aa, ['fetchedAt'])),
    sourceOrigin: aa === null ? null : strOf(aa, ['sourceOrigin']),
    aaReason,
    note: strOf(configured, ['note']),
    whenToUse: strOf(configured, ['whenToUse']),
    whenNotTo: strOf(configured, ['whenNotTo']),
    allZeroCost,
    sources: {
      score: scorePick?.origin === 'aa' || scorePick?.origin === 'config' ? scorePick.origin : null,
      price: priceOrigin,
      context: contextOrigin,
      speed: speedPick?.origin === 'aa' || speedPick?.origin === 'config' ? speedPick.origin : null,
    },
  }
}

/**
 * Format a USD rate per 1M tokens.
 *
 * @param {unknown} value - rate in USD per 1M tokens.
 * @returns {string|null} `$0.15`-style text, or `null` when unknown.
 */
function formatMoney(value) {
  const amount = numberOrNull(value)
  if (amount === null) return null
  if (amount === 0) return '$0.00'
  if (amount >= 0.01) return `$${amount.toFixed(2)}`
  const decimals = amount >= 0.0001 ? 4 : 6
  return `$${amount.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * Format a token count with thousands separators.
 *
 * @param {unknown} value - token count.
 * @returns {string|null} `1,000,000`-style text, or `null` when unknown.
 */
function formatTokens(value) {
  const amount = numberOrNull(value)
  if (amount === null) return null
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format a score with one decimal.
 *
 * @param {unknown} value - score.
 * @returns {string|null} `39.9`-style text, or `null` when unknown.
 */
function formatScore(value) {
  const amount = numberOrNull(value)
  if (amount === null) return null
  return amount.toFixed(1)
}

/**
 * Read a millisecond budget from a number or a `<n>ms` string.
 *
 * @param {unknown} value - candidate budget.
 * @returns {number|null} whole milliseconds, or `null` when unknown.
 */
function msOrNull(value) {
  const direct = numberOrNull(value)
  if (direct !== null) return Math.round(direct)
  if (typeof value === 'string') {
    const match = /(\d+(?:\.\d+)?)\s*ms/i.exec(value)
    if (match !== null) return Math.round(Number(match[1]))
  }
  return null
}

/**
 * Render one Artificial Analysis failure reason as short English text.
 *
 * @param {unknown} reason - lookup failure reason.
 * @param {number|null} timeoutMs - observed timeout budget, when known.
 * @returns {string} the model-facing explanation.
 */
function describeAaReason(reason, timeoutMs) {
  switch (reason) {
    case 'timeout':
      return timeoutMs === null ? 'lookup timed out' : `lookup timed out after ${timeoutMs}ms`
    case 'not-on-aa':
      return 'no Artificial Analysis profile found'
    case 'key-invalid':
      return 'Artificial Analysis API key rejected (check credentials)'
    case 'tier':
      return 'Artificial Analysis tier does not allow this lookup'
    case 'rate-limited':
      return 'Artificial Analysis rate limit reached'
    case 'http':
      return 'Artificial Analysis request failed (HTTP error)'
    case 'unavailable':
      return 'Artificial Analysis lookup unavailable'
    case 'disabled':
      return 'Artificial Analysis lookup disabled'
    case 'offline':
      // Not "disabled": local sources were consulted and simply did not carry
      // this route, so the operator can fix it by syncing a snapshot.
      return 'not in the local snapshot (network lookup is off)'
    default: {
      if (typeof reason === 'string' && reason.length > 0) {
        const short = reason.length > 80 ? `${reason.slice(0, 77)}...` : reason
        return `Artificial Analysis lookup failed (${short})`
      }
      return 'Artificial Analysis lookup unavailable'
    }
  }
}

/**
 * Build the identity line shared by both render layouts.
 *
 * @param {any} profile - merged profile.
 * @returns {string} `provider/model — name`, whichever parts are known.
 */
function identityLine(profile) {
  const parts = []
  if (typeof profile.provider === 'string' && profile.provider.length > 0) parts.push(profile.provider)
  if (typeof profile.model === 'string' && profile.model.length > 0) parts.push(profile.model)
  const id = parts.join('/')
  const name = typeof profile.rawName === 'string' && profile.rawName.length > 0 ? profile.rawName : null
  if (id.length > 0 && name !== null) return `${id}${SEPARATOR}${name}`
  if (id.length > 0) return id
  if (name !== null) return name
  return UNKNOWN_ROUTE
}

/**
 * Build the score fact.
 *
 * @param {any} profile - merged profile.
 * @returns {string|null} `score 39.9 (AA Intelligence Index v4.3)`, or `null`.
 */
function scoreFact(profile) {
  const score = formatScore(profile.scores)
  if (score === null) return null
  const label = [profile.scoreName, profile.scoreVersion]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
  return label.length === 0 ? `score ${score}` : `score ${score} (${label})`
}

/**
 * Build the price fact.
 *
 * @param {any} profile - merged profile.
 * @param {boolean} isSingle - whether the single-model dossier layout is used.
 * @returns {string|null} the price fact, or `null` when no rate is known.
 */
function priceFact(profile, isSingle) {
  const price = isPlainObject(profile.pricePer1M) ? profile.pricePer1M : null
  if (price === null) return null
  const input = formatMoney(price.input)
  const output = formatMoney(price.output)
  const cacheRead = formatMoney(price.cacheRead)
  if (profile.allZeroCost === true) {
    const label = isSingle ? 'price in/out/cacheRead per 1M' : 'price in/out per 1M'
    return `${label}: subscription route (catalogue rate 0)`
  }
  if (isSingle && input !== null && output !== null && cacheRead !== null) {
    return `price in/out/cacheRead ${input}/${output}/${cacheRead} per 1M`
  }
  if (input !== null && output !== null) return `price in/out ${input}/${output} per 1M`
  if (input !== null) return `price in ${input} per 1M`
  if (output !== null) return `price out ${output} per 1M`
  if (cacheRead !== null) return `price cacheRead ${cacheRead} per 1M`
  return null
}

/**
 * Build the context-window fact.
 *
 * `profile.contextOrigin` decides the wording, and the cases are NOT
 * interchangeable:
 *
 *   - `runtime` / `config` — a number the running adapter or the operator
 *     states for THIS deployment. It is printed bare, because it is the
 *     operational limit.
 *   - `pi-ai` — a figure from the bundled pi-ai catalogue. The catalogue
 *     describes the upstream model, not what this deployment's adapter
 *     enforces (the live Qwen route is catalogued at 1,000,000 while the
 *     adapter reports 272,000), so it is labelled as a catalogue value and
 *     never presented as the operational limit. It is reached only when
 *     neither the runtime nor the configured layer supplied a number.
 *   - `aa` — Artificial Analysis's figure. AA derives it from its own model
 *     metadata and rounds it in prose ("260k tokens" for a model the adapter
 *     resolves to 272000), so it is labelled as AA's and marked approximate.
 *
 * @param {any} profile - merged profile.
 * @param {boolean} isSingle - whether the dossier layout is used.
 * @returns {string|null} the context fact, or `null`.
 */
function contextFact(profile, isSingle) {
  const tokens = formatTokens(profile.contextWindow)
  if (tokens === null) return null
  if (profile.contextOrigin === 'aa') {
    return isSingle
      ? `context ${tokens} tokens (AA, approximate)`
      : `context ${tokens} (AA, approximate)`
  }
  if (profile.contextOrigin === 'pi-ai') {
    return isSingle
      ? `context ${tokens} tokens (pi-ai catalogue)`
      : `context ${tokens} (pi-ai catalogue)`
  }
  return isSingle ? `context ${tokens} tokens` : `context ${tokens}`
}

/**
 * Build the speed and latency facts.
 *
 * The latency label is spelled out because the metric it prints is AA's
 * "Time To First Answer Token" (input processing plus model thinking), which is
 * much larger than a per-chunk time-to-first-token for the same model. Calling
 * it "latency" or "TTFT" here would invite the wrong comparison.
 *
 * @param {any} profile - merged profile.
 * @param {boolean} isSingle - whether the dossier layout is used.
 * @returns {string[]} the facts that are known.
 */
function speedFacts(profile, isSingle) {
  const facts = []
  const speed = numberOrNull(profile.tokensPerSecond)
  if (speed !== null) facts.push(`speed ${speed.toFixed(1)} tok/s`)
  const latency = numberOrNull(profile.timeToFirstAnswerTokenSeconds)
  if (latency !== null) facts.push(`latency to first answer token ${latency.toFixed(2)}s`)
  if (facts.length > 0) return facts
  // "not measured" is used only where its absence would be read as "fine":
  // AA returned a profile for this route but published no speed measurement.
  if (isSingle && profile.aaReason === null && profile.sourceOrigin !== null) return ['speed not measured']
  return facts
}

/**
 * Build the reasoning-effort fact.
 *
 * @param {any} profile - merged profile.
 * @returns {string|null} `reasoning low, medium (default medium)`, or `null`.
 */
function reasoningFact(profile) {
  const reasoning = isPlainObject(profile.reasoning) ? profile.reasoning : null
  if (reasoning === null) return null
  const ids = Array.isArray(reasoning.efforts)
    ? reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id.length > 0)
    : []
  const defaultEffort = typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort.length > 0
    ? reasoning.defaultEffort
    : null
  if (ids.length === 0) return defaultEffort === null ? null : `reasoning (default ${defaultEffort})`
  const suffix = defaultEffort === null ? '' : ` (default ${defaultEffort})`
  return `reasoning ${ids.join(', ')}${suffix}`
}

/**
 * Format the body lines of one profile block.
 *
 * The caller prepends one blank line and joins the result with `'\n'`; these
 * lines never start with a blank line.
 *
 * Both layouts are model-facing English: `isSingle: false` is the compact block
 * appended after a native model list, `isSingle: true` is the full dossier for
 * a single-model detail call. Unknown fields are omitted, never printed as `0`.
 * When `includeAttribution` is true the block ends with
 * `Source: Artificial Analysis (artificialanalysis.ai)` and, when known, the
 * specific `sourceUrl`.
 *
 * @param {any} profile - merged profile from {@link mergeProfile}.
 * @param {{ showWhenToUse?: boolean, includeAttribution?: boolean, isSingle?: boolean, aaTimeoutMs?: number|string }} [options]
 *   render switches; `showWhenToUse` and `includeAttribution` default to true.
 * @returns {string[]} body lines.
 */
export function formatProfileLines(profile, options) {
  try {
    const source = isPlainObject(profile) ? profile : {}
    const opts = isPlainObject(options) ? options : {}
    const isSingle = opts.isSingle === true
    const showWhenToUse = opts.showWhenToUse !== false
    const includeAttribution = opts.includeAttribution !== false
    const timeoutMs = msOrNull(opts.aaTimeoutMs) ?? msOrNull(source.aaTimeoutMs)

    const lines = [identityLine(source)]
    const indent = (text) => `  ${text}`

    if (source.aaReason !== null && source.aaReason !== undefined) {
      lines.push(indent(`not available: ${describeAaReason(source.aaReason, timeoutMs)}`))
    }

    if (!isSingle) {
      // Compact block: exactly the five selection facts the plan names for the
      // list layout. Reasoning levels, modalities, alias, rank and the
      // when-to-use prose are what the single-model dossier ADDS, so a list of
      // thirty models stays two lines per model.
      const facts = []
      const score = scoreFact(source)
      if (score !== null) facts.push(score)
      const price = priceFact(source, false)
      if (price !== null) facts.push(price)
      const context = contextFact(source, false)
      if (context !== null) facts.push(context)
      facts.push(...speedFacts(source, false))
      if (facts.length > 0) lines.push(indent(facts.join(' \u00b7 ')))
      if (includeAttribution) {
        if (typeof source.sourceUrl === 'string' && source.sourceUrl.length > 0) {
          lines.push(`Source URL: ${source.sourceUrl}`)
        }
        lines.push(AA_ATTRIBUTION)
      }
      return lines
    }

    const score = scoreFact(source)
    const rank = numberOrNull(source.rank)
    const rankFact = rank === null
      ? null
      : numberOrNull(source.ofCount) === null
        ? `rank ${rank}`
        : `rank ${rank} of ${formatTokens(source.ofCount)}`
    const scoreGroup = [score, rankFact].filter((fact) => fact !== null)
    if (scoreGroup.length > 0) lines.push(indent(scoreGroup.join(' \u00b7 ')))

    const price = priceFact(source, true)
    if (price !== null) lines.push(indent(price))

    const context = contextFact(source, true)
    const maxOutput = formatTokens(source.maxTokens)
    const sizeGroup = [context, maxOutput === null ? null : `max output ${maxOutput}`]
      .filter((fact) => fact !== null)
    if (sizeGroup.length > 0) lines.push(indent(sizeGroup.join(' \u00b7 ')))

    const speed = speedFacts(source, true)
    if (speed.length > 0) lines.push(indent(speed.join(' \u00b7 ')))

    const reasoning = reasoningFact(source)
    if (reasoning !== null) lines.push(indent(reasoning))

    if (Array.isArray(source.inputModalities) && source.inputModalities.length > 0) {
      lines.push(indent(`input modalities ${source.inputModalities.join(', ')}`))
    }
    if (typeof source.aliasOf === 'string' && source.aliasOf.length > 0) {
      lines.push(indent(`alias of ${source.aliasOf}`))
    }
    if (typeof source.note === 'string' && source.note.length > 0) lines.push(indent(`note: ${source.note}`))
    if (showWhenToUse && typeof source.whenToUse === 'string' && source.whenToUse.length > 0) {
      lines.push(indent(`when to use: ${source.whenToUse}`))
    }
    if (showWhenToUse && typeof source.whenNotTo === 'string' && source.whenNotTo.length > 0) {
      lines.push(indent(`when not to use: ${source.whenNotTo}`))
    }

    if (includeAttribution) {
      if (typeof source.sourceUrl === 'string' && source.sourceUrl.length > 0) {
        lines.push(`Source URL: ${source.sourceUrl}`)
      }
      lines.push(AA_ATTRIBUTION)
    }
    return lines
  } catch {
    return []
  }
}

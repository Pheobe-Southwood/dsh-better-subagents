/**
 * Model-id normalisation and Artificial Analysis (AA) slug candidates.
 *
 * The harness names a model twice over: a *route* (`qwen-token-plan-cn`, the
 * provider key in the profile's model table) and a *model id* inside it
 * (`qwen3.8-flash`). Artificial Analysis names the same model a third way
 * (`qwen3-8-flash-next`). This module is the pure half of reconciling the two:
 * it canonicalises a local id and proposes the AA slugs worth probing, most
 * likely first.
 *
 * No network, no logging, no work at import time: the only I/O in the whole
 * module is the alias table, read once on the first `aaSlugCandidates()` call.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** Our own name mappings, shipped beside the source — never AA data. */
const DEFAULT_ALIASES_PATH = join(MODULE_DIR, '..', 'data', 'aliases.json')

/** How many AA slugs we are willing to probe for a single model. */
const MAX_CANDIDATES = 6

/** A trailing 4-digit (`-0731`) or 8-digit (`-20250731`) build stamp. */
const TRAILING_DATE_RE = /-(?:\d{8}|\d{4})$/

/** Keys that are metadata rather than aliases when a file has no wrapper. */
const META_KEYS = new Set(['version', 'note', 'comment', '$schema'])

/**
 * Canonicalise a local model id for comparison and lookup.
 *
 * Order of operations, each one deliberately conservative:
 *   - lowercase and trim;
 *   - drop a provider prefix (`foo/bar` -> `bar`, last segment wins);
 *   - `_` and whitespace runs become `-`;
 *   - a `.` *between a digit and a following digit or letter* becomes `-`, the
 *     dotted-version form (`qwen3.8-flash` -> `qwen3-8-flash`, `gpt-5.6-luna` ->
 *     `gpt-5-6-luna`, `llama-3.1-70b` -> `llama-3-1-70b`). This rule is
 *     deliberately narrow: a digit running straight into a letter is part of
 *     the model's name, not a version boundary, so `gpt-oss-120b` stays
 *     `gpt-oss-120b` instead of becoming the non-existent `gpt-oss-120-b`;
 *   - collapse repeated `-` and trim stray leading/trailing `-`.
 *
 * A trailing version or date suffix is NOT stripped here: `-next`, `-0731` and
 * friends are part of the identity, and dropping them here would make the
 * function lossy. `aaSlugCandidates()` derives those variants explicitly.
 *
 * @param {string} value Raw model id (any case, optionally provider-prefixed).
 * @returns {string} Canonical id, or `''` for anything that is not a string
 *   with some content after trimming.
 */
export function normalizeModelId(value) {
  if (typeof value !== 'string') return ''
  let id = value.trim().toLowerCase()
  if (id === '') return ''
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  id = id.replace(/[_\s]+/g, '-')
  // Dotted-version boundary only: `qwen3.8` -> `qwen3-8`, `5.6` -> `5-6`.
  // A digit followed directly by a letter (`120b`, `70b`, `4o`) is left alone:
  // splitting it would invent slugs such as `gpt-oss-120-b` that no catalogue
  // carries. Repeated dots collapse to one `-`.
  id = id.replace(/(\d)\.+(?=[0-9a-z])/g, '$1-')
  id = id.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return id
}

/**
 * The ordered, de-duplicated AA slugs to try for one local model id.
 *
 *   1. our alias table, when the raw id or its normalized form is a key —
 *      this encodes the handful of mappings a pure name transform cannot
 *      express (`qwen3.8-flash` -> `qwen3-8-flash-next`, the production slug);
 *   2. the normalized id itself;
 *   3. the version-stripped form, when the normalized id ends in a 4- or
 *      8-digit build stamp;
 *   4. `${normalized}-next`, last and only when the id is not already `-next`.
 *
 * Step 4 is a documented heuristic for AA's preview-vs-production naming: a
 * local id usually names the preview while AA often carries the production
 * variant under the same name plus `-next`. It is last because the identity
 * match deserves to win.
 *
 * @param {string} modelId Raw model id.
 * @returns {string[]} At most {@link MAX_CANDIDATES} slugs, most likely first.
 */
export function aaSlugCandidates(modelId) {
  const candidates = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const slug = value.trim().toLowerCase()
    if (slug === '' || seen.has(slug)) return
    seen.add(slug)
    candidates.push(slug)
  }

  const normalized = normalizeModelId(modelId)

  const alias = lookupAlias(modelId, normalized)
  if (alias !== null) push(alias)

  if (normalized !== '') {
    push(normalized)

    const stripped = normalized.replace(TRAILING_DATE_RE, '')
    if (stripped !== '') push(stripped)

    if (!normalized.endsWith('-next')) push(`${normalized}-next`)
  }

  return candidates.slice(0, MAX_CANDIDATES)
}

/**
 * Read an alias table from disk.
 *
 * Accepts the shipped shape (`{ version, note, aliases: { id: slug } }`) and,
 * for hand-written fixtures, a bare `{ id: slug }` object. Never throws: a
 * missing file, unreadable file, invalid JSON, wrong shape or non-string entry
 * all degrade to `{}` (or to skipping that entry), because a broken alias table
 * must never take the plugin down.
 *
 * A document that *declares* `aliases` but gives it a non-object value is
 * malformed rather than bare: falling back to bare-map mode there would turn
 * the wrapper value itself into an alias named `aliases`.
 *
 * @param {string} aliasesPath Path to a JSON alias table.
 * @returns {Record<string, string>} Own-enumerable `local id -> AA slug` map.
 */
export function loadAliases(aliasesPath) {
  try {
    if (typeof aliasesPath !== 'string' || aliasesPath.trim() === '') return {}
    const parsed = JSON.parse(readFileSync(aliasesPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const wrapped = isRecord(parsed.aliases)
    if (!wrapped && Object.hasOwn(parsed, 'aliases')) return {}
    const source = wrapped ? parsed.aliases : parsed
    const out = {}
    for (const [key, value] of Object.entries(source)) {
      if (!wrapped && META_KEYS.has(key)) continue
      if (typeof key !== 'string' || key.trim() === '') continue
      if (typeof value !== 'string' || value.trim() === '') continue
      // defineProperty, not `out[key] = value`: a literal `__proto__` key in a
      // JSON file must stay inert data.
      Object.defineProperty(out, key, {
        value: value.trim(),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Module-level cache for the shipped table, populated on first use only.
 * A null-prototype object so that lookups can never hit `Object.prototype`
 * members such as `constructor` or `toString`.
 */
let aliasCache = null

function defaultAliases() {
  if (aliasCache === null) {
    aliasCache = Object.create(null)
    for (const [key, slug] of Object.entries(loadAliases(DEFAULT_ALIASES_PATH))) {
      aliasCache[key] = slug
    }
  }
  return aliasCache
}

function lookupAlias(modelId, normalized) {
  if (typeof modelId !== 'string') return null
  const table = defaultAliases()
  const raw = modelId.trim()
  const keys = [raw, raw.toLowerCase()]
  if (normalized !== '') keys.push(normalized)
  for (const key of keys) {
    if (key !== '' && Object.hasOwn(table, key)) return table[key]
  }
  return null
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

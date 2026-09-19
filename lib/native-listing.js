/**
 * Pure parsing of the native `list_subagent_models` result text.
 *
 * The native tool (see `@deepseek-ai/dsh-tool-subagent`) renders one of three
 * shapes, always as a single text block:
 *
 * - providers: one line per provider, `` `${provider.id} — ${provider.name}` ``,
 *   or the literal `(no LLM providers)`.
 * - models: one line per model, `` `${provider}/${model.id} — ${model.name}` ``
 *   with an optional `` `: ${model.description}` `` suffix, or the literal
 *   `` `(no advertised models for ${provider.id})` ``.
 * - model: the model line, then `\nReasoning efforts:\n` and one line per
 *   effort, or the literal `(no advertised reasoning efforts)`.
 *
 * The separator is an em dash U+2014 surrounded by spaces (`' — '`).
 *
 * {@link parseProviderRoutes} additionally reads the no-argument listing as
 * candidate ROUTES: a bare provider line stays a provider with a `null` model
 * (its advertised models must be resolved by the caller), while a line that
 * already names a model is used directly.
 *
 * Every export in this module is pure and total: it never performs I/O, never
 * mutates its input, and never throws. Unrecognized text yields the empty
 * result (`[]` / `null`) instead of a guess, because a wrong parse would make
 * the enrichment claim things about a route the model did not ask about.
 *
 * Byte-for-byte preservation is a first-class property of this module:
 * {@link parseModelDetail} returns the reasoning block as the verbatim
 * substring `text.slice(startOfHeaderLine)`, so a renderer can re-emit it
 * without normalizing a single character (including trailing newlines).
 *
 * @module dsh-better-subagents/native-listing
 */

/** Exact native tool name whose result text this plugin enriches. */
export const NATIVE_TOOL_NAME = 'list_subagent_models'

/** Identity/name separator emitted by the native tool: em dash U+2014, space-padded. */
const SEPARATOR = ' \u2014 '

/** Header line that introduces the reasoning-effort block of a model detail. */
const REASONING_HEADER = 'Reasoning efforts:'

/** Literal native output for an empty reasoning-effort list. */
const NO_REASONING_EFFORTS = '(no advertised reasoning efforts)'

/**
 * Split result text into significant lines, dropping trailing empty lines.
 *
 * @param {unknown} text - candidate result text.
 * @returns {string[]} lines, or `[]` when `text` is not a non-empty string.
 */
function significantLines(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Whether one token can be a provider id or model id.
 *
 * Ids may contain letters, digits, `-`, `.`, `_`, `:` and (for model ids) `/`;
 * they never contain whitespace and are never empty.
 *
 * @param {unknown} value - candidate token.
 * @returns {boolean} whether the token has identifier shape.
 */
function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

/**
 * Parse one `provider/model — name[: description]` line.
 *
 * Splits on the FIRST `' — '`, then on the FIRST `'/'` of the left part, then
 * on the FIRST `': '` of the right part. `description` is `null` when the line
 * carries no `': '` suffix.
 *
 * @param {unknown} line - one candidate model line.
 * @returns {{ provider: string, model: string, name: string, description: string|null }|null}
 *   the parsed line, or `null` when it is not structurally a model line.
 */
function parseModelLine(line) {
  if (typeof line !== 'string') return null
  const separatorAt = line.indexOf(SEPARATOR)
  if (separatorAt <= 0) return null
  const left = line.slice(0, separatorAt)
  const right = line.slice(separatorAt + SEPARATOR.length)
  if (right.length === 0) return null
  const slashAt = left.indexOf('/')
  if (slashAt <= 0 || slashAt === left.length - 1) return null
  const provider = left.slice(0, slashAt)
  const model = left.slice(slashAt + 1)
  if (!isIdentifier(provider) || !isIdentifier(model)) return null
  const colonAt = right.indexOf(': ')
  let name = right
  let description = null
  if (colonAt >= 0) {
    name = right.slice(0, colonAt)
    description = right.slice(colonAt + 2)
  }
  if (name.length === 0) return null
  return { provider, model, name, description }
}

/**
 * Coerce tool arguments into a plain object when possible.
 *
 * `exec.arguments` is normally the parsed argument object, but it is the raw
 * string when the model's JSON failed to parse; `null`/`undefined` means the
 * tool was called without arguments.
 *
 * @param {unknown} args - tool arguments in either form.
 * @returns {Record<string, unknown>|undefined} the argument object, or
 *   `undefined` when the value cannot be interpreted as an argument object.
 */
function coerceArgs(args) {
  if (args === undefined || args === null) return {}
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed)
      }
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    return /** @type {Record<string, unknown>} */ (args)
  }
  return undefined
}

/**
 * Detect which native listing mode one call was in.
 *
 * @param {unknown} args - `exec.arguments` (parsed object, raw JSON string, or
 *   absent). An absent value means "no arguments" and therefore `'providers'`;
 *   a raw string that is not valid JSON, a non-object value, or a present but
 *   non-string/empty `provider`/`model` yields `'unknown'` (never a guess).
 * @returns {'providers'|'models'|'model'|'unknown'} the detected mode.
 */
export function detectMode(args) {
  const value = coerceArgs(args)
  if (value === undefined) return 'unknown'
  const provider = value.provider
  const model = value.model
  if (provider === undefined && model === undefined) return 'providers'
  if (typeof provider !== 'string' || provider.length === 0) return 'unknown'
  if (model === undefined) return 'models'
  if (typeof model !== 'string' || model.length === 0) return 'unknown'
  return 'model'
}

/**
 * Join the text blocks of a tool result into one string.
 *
 * Non-text blocks are ignored here; the caller preserves them in place.
 *
 * @param {unknown} content - `result.content`.
 * @returns {string} text blocks joined with `'\n'`, or `''` when there are none.
 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Parse one provider-only `provider — name` line.
 *
 * @param {unknown} line - one candidate provider line.
 * @returns {{ provider: string, name: string }|null} the parsed line, or `null`
 *   when it is not structurally a provider line (a model line's `/` is
 *   rejected here, because that line names a route, not a provider).
 */
function parseProviderLine(line) {
  if (typeof line !== 'string') return null
  const separatorAt = line.indexOf(SEPARATOR)
  if (separatorAt <= 0) return null
  const left = line.slice(0, separatorAt)
  const name = line.slice(separatorAt + SEPARATOR.length)
  if (name.length === 0) return null
  if (!isIdentifier(left)) return null
  if (left.includes('/')) return null
  return { provider: left, name }
}

/**
 * Parse a provider listing.
 *
 * Every significant line must be `"<provider> — <name>"` with no `/` in the
 * left part; otherwise the text is not a provider listing and `[]` is returned.
 * Literals such as `(no LLM providers)` and model listings return `[]`.
 *
 * @param {unknown} text - result text.
 * @returns {{ provider: string, name: string }[]} parsed providers, or `[]`.
 */
export function parseProviderList(text) {
  const lines = significantLines(text)
  if (lines.length === 0) return []
  const providers = []
  for (const line of lines) {
    const parsed = parseProviderLine(line)
    if (parsed === null) return []
    providers.push(parsed)
  }
  return providers
}

/**
 * Parse a no-argument provider listing into candidate ROUTES.
 *
 * The native no-argument output names providers, not routes, so this parser is
 * the one place that keeps both shapes of a delegation listing usable:
 *
 * - `"<provider>/<model> — <name>"` — an explicit route; `model` is its id.
 * - `"<provider> — <name>"` — a bare provider; `model` is `null` and the caller
 *   must resolve that provider's advertised models before it can profile
 *   anything.
 *
 * A bare provider line is accepted by the exact rule {@link parseProviderList}
 * applies — both call the same `parseProviderLine` helper — so this parser only
 * ADDS the explicit-route shape to that listing, and never loosens what counts
 * as a provider.
 *
 * The parse stays strict: EVERY significant line must match one of the two
 * shapes, otherwise `[]` is returned. A single unrecognized line therefore
 * rejects the whole text instead of letting the caller attach facts to a route
 * the listing never named. Because the parse is strict, a parsed entry's index
 * is its line index, which is what line annotations rely on.
 *
 * @param {unknown} text - result text.
 * @returns {{ provider: string, model: string|null, name: string }[]} parsed
 *   lines in order, or `[]` when the text is not a provider/route listing.
 */
export function parseProviderRoutes(text) {
  const lines = significantLines(text)
  if (lines.length === 0) return []
  const routes = []
  for (const line of lines) {
    const model = parseModelLine(line)
    if (model !== null) {
      routes.push({ provider: model.provider, model: model.model, name: model.name })
      continue
    }
    const provider = parseProviderLine(line)
    if (provider === null) return []
    routes.push({ provider: provider.provider, model: null, name: provider.name })
  }
  return routes
}

/**
 * Parse a model listing.
 *
 * Every significant line must be `"<provider>/<model> — <name>"`, optionally
 * followed by `": <description>"`. A single unmatched line rejects the whole
 * text, so a reasoning block, a detail output, or any literal yields `[]`.
 *
 * `description` is `null` when the line has no description suffix; an empty
 * description is reported as `''`, exactly as the native renderer emitted it.
 *
 * @param {unknown} text - result text.
 * @returns {{ provider: string, model: string, name: string, description: string|null }[]}
 *   parsed models, or `[]`.
 */
export function parseModelList(text) {
  const lines = significantLines(text)
  if (lines.length === 0) return []
  const models = []
  for (const line of lines) {
    const parsed = parseModelLine(line)
    if (parsed === null) return []
    models.push(parsed)
  }
  return models
}

/**
 * Parse a single-model detail output.
 *
 * The first line must be a model line. The remainder must either be absent or
 * start with the `Reasoning efforts:` header; every following non-empty line
 * must look like an effort line (containing `' — '`) or be the literal
 * `(no advertised reasoning efforts)`.
 *
 * `reasoningSyntax` is the VERBATIM substring from the start of the
 * `Reasoning efforts:` header line to the end of the input, header included, so
 * a renderer can re-emit it byte-for-byte (trailing newlines included). It is
 * `null` when the detail carries no reasoning block.
 *
 * @param {unknown} text - result text.
 * @returns {{ provider: string, model: string, name: string, description: string|null, reasoningSyntax: string|null }|null}
 *   the parsed detail, or `null` when the text is not a model detail.
 */
export function parseModelDetail(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const lines = text.split('\n')
  const head = parseModelLine(lines[0])
  if (head === null) return null
  if (lines.length === 1 || (lines.length === 2 && lines[1] === '')) {
    return { ...head, reasoningSyntax: null }
  }
  if (lines[1] !== REASONING_HEADER) return null
  for (let index = 2; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    if (line === NO_REASONING_EFFORTS) continue
    if (!line.includes(SEPARATOR)) return null
  }
  // Byte-for-byte: slice the original string from the header line's offset.
  const reasoningSyntax = text.slice(lines[0].length + 1)
  return { ...head, reasoningSyntax }
}

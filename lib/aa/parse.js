/**
 * Pure parsing of Artificial Analysis (AA) payloads.
 *
 * Two sources, two parsers, no I/O:
 *
 *   - `parseAaModelPage(html)` reads a public model page
 *     (`https://artificialanalysis.ai/models/<slug>`). AA ships the numbers in
 *     schema.org `Dataset` blocks inside `<script type="application/ld+json">`
 *     tags, one block per metric, each carrying a leaderboard slice whose
 *     entries point back at their model with `detailsUrl`. The model this page
 *     is about is therefore the entry whose `detailsUrl` (or `label`) names the
 *     page; every metric is read from that entry, never from the surrounding
 *     ranking table.
 *   - `parseAaFreeIndex(json)` reads the Free-tier index endpoint
 *     (`/api/v2/language/models/free`), whose response shape is *documented*
 *     but was not observable while this module was written (no API key — see
 *     the notes on {@link parseAaFreeIndex}).
 *
 * Both entry points are total: malformed input yields `null` / `[]`, never a
 * throw. Neither adds provenance or attribution — `lib/aa/client.js` owns both.
 *
 * Numbers follow AA's own convention: a missing measurement is `null`, never
 * `0`. A *present* zero stays `0`, because AA does report genuine zeroes (a
 * non-reasoning route has `reasoningTime: 0`, and token-plan routes really do
 * cost nothing per token).
 */

/** Matches one `<script type="application/ld+json">…</script>` payload. */
const LD_JSON_RE =
  /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi

/** Matches any `<link …>` tag, so `rel`/`href` may appear in either order. */
const LINK_TAG_RE = /<link\b[^>]*>/gi

/** Matches any `<meta …>` tag, for the same reason. */
const META_TAG_RE = /<meta\b[^>]*>/gi

/** Matches a complete `<h1 …>…</h1>` element. */
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i

/** Matches a `<script …>…</script>` element, for the text-only projection. */
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi

/** Matches a `<style …>…</style>` element, for the text-only projection. */
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi

/** Matches any remaining tag, for the text-only projection. */
const TAG_RE = /<[^>]*>/g

/** A POSIX-style name is not needed here; this is only a cheap "is it empty" test. */
const NUMBER_PREFIX_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

/** `"1M"`, `"128K"`, `"1,000,000"`, `"260k tokens"` — the number part. */
const TOKEN_COUNT_RE = /(\d+(?:\.\d+)?)\s*([kmb])?/i

/** AA's name for the index every score in this plugin comes from. */
const INTELLIGENCE_SCORE_NAME = 'Artificial Analysis Intelligence Index'

/**
 * Entry field names, most authoritative first, that carry an intelligence
 * index score. The order matters: a page can carry both the chart-local
 * `intelligenceIndex` and the generic `score` of an adjacent capability index.
 */
const SCORE_FIELDS = [
  'intelligenceIndex',
  'artificialAnalysisIntelligenceIndex',
  'artificial_analysis_intelligence_index',
  'medianIntelligenceIndex',
  'intelligence_index',
  'score',
]

/** Entry field names that carry output speed in tokens per second. */
const SPEED_FIELDS = [
  'medianOutputTokensPerSecond',
  'median_output_tokens_per_second',
  'medianOutputSpeed',
  'median_output_speed',
  'outputSpeed',
  'outputTokensPerSecond',
  'tokensPerSecond',
]

/**
 * Entry field names that already *are* a time to first answer token, used when
 * AA publishes the metric as a single number instead of the `inputTime` /
 * `reasoningTime` pair the latency dataset normally carries.
 */
const LATENCY_FIELDS = [
  'medianTimeToFirstAnswerTokenSeconds',
  'medianTimeToFirstTokenSeconds',
  'medianTimeToFirstAnswerToken',
  'median_time_to_first_answer_token_seconds',
  'median_time_to_first_token_seconds',
  'timeToFirstAnswerToken',
  'timeToFirstAnswerTokenSeconds',
  'medianTimeToFirstChunk',
  'median_time_to_first_chunk_seconds',
]

/**
 * Names of datasets that DO measure time to first answer token.
 *
 * AA spells the metric out in the block name; the shipped build was observed
 * carrying exactly `Latency: Time To First Answer Token` with description
 * "Seconds to first answer token received · Accounts for reasoning model
 * 'thinking' time".
 */
const TTFT_BLOCK_RE = /time\s+to\s+first\s+(?:answer\s+)?token|time\s+to\s+first\s+chunk/i

/**
 * Names of datasets that must NEVER be read as TTFT.
 *
 * Each of these reuses the latency block's field names (`inputTime`,
 * `reasoningTime`) or is a per-task aggregate, so any rule that selects by
 * "has a time-shaped field" picks the wrong one. Observed on
 * `qwen3-8-flash-next`: the End-to-End Response Time block carries the same
 * `inputTime` (2.889) and `reasoningTime` (36.058) as the latency block, and
 * summing the pair yields 38.95 — a 13x error against AA's own stated TTFT.
 */
const TTFT_EXCLUDED_BLOCK_RE = /end[\s-]*to[\s-]*end|per\s+intelligence\s+index\s+task|per\s+task|intelligence\s+index\s+cost|cost\s+per|output\s+tokens/i

/**
 * Flat price field names, used when a payload carries prices outside the
 * `pricing: [{ name, value }]` array AA's pricing dataset uses.
 *
 * Only names that literally say "price" (or the documented `price_1m_*`
 * convention) appear here: AA's per-task *cost* datasets also expose bare
 * `input` / `cacheHit` numbers, and those are USD per Intelligence Index task,
 * not USD per 1M tokens. Reading them as prices would understate every price
 * by two orders of magnitude.
 */
const PRICE_INPUT_FIELDS = [
  'inputPrice',
  'inputPricePer1M',
  'price1mInputTokens',
  'price_1m_input_tokens',
  'price_per_1m_input_tokens',
  'input_price',
]

/** Output-token price field names; see {@link PRICE_INPUT_FIELDS}. */
const PRICE_OUTPUT_FIELDS = [
  'outputPrice',
  'outputPricePer1M',
  'price1mOutputTokens',
  'price_1m_output_tokens',
  'price_per_1m_output_tokens',
  'output_price',
]

/** Cached-input ("cache hit"/"cache read") price field names. */
const PRICE_CACHE_FIELDS = [
  'cacheHitPrice',
  'cacheReadPrice',
  'cacheHitPricePer1M',
  'cacheReadPricePer1M',
  'price1mCacheHitTokens',
  'price_1m_cache_hit_tokens',
  'price_1m_cache_read_tokens',
  'cache_hit_price',
  'cache_read_price',
]

/** Documented envelope keys that may hold the entry array of the Free endpoint. */
const INDEX_ENTRY_KEYS = ['data', 'models', 'results', 'items']

/** Fields whose value is a generation timestamp rather than a measurement. */
const GENERATED_AT_FIELDS = [
  'generated_at',
  'generatedAt',
  'updated_at',
  'updatedAt',
  'last_updated_at',
  'dateModified',
  'datePublished',
]

// ---------------------------------------------------------------------------
// public parsers
// ---------------------------------------------------------------------------

/**
 * Parse an Artificial Analysis model page.
 *
 * Reads every `application/ld+json` block, keeps the `Dataset` blocks, and
 * pulls the one entry per block that belongs to this page (`detailsUrl` ending
 * in the canonical slug, or a `label` equal to the page title). Then:
 *
 *   - `scores` / `scoreName` / `scoreVersion` from the Intelligence Index
 *     blocks. `scoreVersion` is parsed out of the block text, which is where AA
 *     states it ("Artificial Analysis Intelligence Index v4.3 incorporates 10
 *     evaluations: …").
 *   - `tokensPerSecond` from any output-speed field present.
 *   - `timeToFirstAnswerTokenSeconds` from the "Latency: Time To First Answer
 *     Token" dataset. AA stores that metric in two parts — `inputTime` (input
 *     processing) and `reasoningTime` (model thinking) — and displays their
 *     sum, so this parser returns the sum. A lone part is returned as-is, and
 *     an explicit answer-token field wins over the sum. This is NOT a
 *     time-to-first-token: AA's own FAQ quotes a far smaller per-chunk TTFT for
 *     the same model, and the two numbers answer different questions.
 *   - `pricePer1M` from the pricing dataset's `[{ name, value }]` array
 *     (`cacheHitPrice` → `cacheRead`, `inputPrice` → `input`, `outputPrice` →
 *     `output`), or from explicit flat price fields.
 *   - `contextWindow` from the Context Window dataset. That dataset is a
 *     *leaderboard slice*, so a model outside it (a 256k-context model on a
 *     page whose chart shows the twenty 1M-context leaders) has no entry; the
 *     page's own FAQ prose ("has a context window of 260k tokens") is then used
 *     as a documented, rounded fallback.
 *   - `creator` from the page's FAQ ("… was created by Alibaba."), falling back
 *     to the `og:description` sentence ("Analysis of Alibaba's …").
 *   - `rank` / `ofCount`: see {@link extractRankAndCount}. `rank` is always
 *     `null` in practice — AA does not publish a per-model rank on these pages,
 *     and the "27 of 653 models" text is a model-picker counter, verified
 *     identical on the #1 model and on far weaker ones.
 *   - `generatedAt` from a `dateModified` / `datePublished` anywhere in the
 *     blocks. AA's current pages carry neither, so this is normally `null`.
 *
 * @param {string} html Raw HTML of a model page.
 * @returns {{
 *   name: string|null,
 *   slug: string|null,
 *   creator: string|null,
 *   rank: number|null,
 *   ofCount: number|null,
 *   scores: number|null,
 *   scoreName: string,
 *   scoreVersion: string|null,
 *   tokensPerSecond: number|null,
 *   timeToFirstAnswerTokenSeconds: number|null,
 *   pricePer1M: { input: number|null, output: number|null, cacheRead: number|null },
 *   contextWindow: number|null,
 *   generatedAt: string|null,
 * }|null} The page profile, or `null` when the document carries nothing usable
 *   (a 404 page, a non-page payload, garbage).
 */
export function parseAaModelPage(html) {
  try {
    if (typeof html !== 'string' || html.trim() === '') return null

    const blocks = extractJsonLd(html)
    if (blocks.length === 0) return null

    const datasets = blocks.filter((block) => isRecord(block) && Array.isArray(block.data))
    if (datasets.length === 0) return null

    const slug = readCanonicalSlug(html)
    const name = readPageName(html)
    if (slug === null && name === null) return null

    /** The one entry per dataset that belongs to this page. */
    const matched = []
    for (const block of datasets) {
      for (const entry of block.data) {
        if (entryBelongsToPage(entry, slug, name)) {
          matched.push({ block, entry })
          break
        }
      }
    }

    const score = readScore(matched)
    const speed = readSpeed(matched)
    const latency = readAnswerTokenLatency(matched)
    const price = readPrice(matched)
    const contextWindow = readContextWindow(matched) ?? readFaqContextWindow(blocks)
    const creator = readCreator(blocks, html, name)
    const rankInfo = extractRankAndCount(toVisibleText(html))
    const generatedAt = readGeneratedAt(blocks)

    if (matched.length === 0 && name === null && creator === null && contextWindow === null) {
      return null
    }

    return {
      name,
      slug,
      creator,
      rank: rankInfo.rank,
      ofCount: rankInfo.ofCount,
      scores: score === null ? null : score.value,
      scoreName: score === null ? INTELLIGENCE_SCORE_NAME : score.name,
      scoreVersion: readScoreVersion(datasets),
      tokensPerSecond: speed,
      timeToFirstAnswerTokenSeconds: latency,
      pricePer1M: price,
      contextWindow,
      generatedAt,
    }
  } catch {
    return null
  }
}

/**
 * Parse the Free-tier model index into flat, normalized entries.
 *
 * The endpoint is documented as returning `snake_case` fields inside an
 * envelope:
 *
 * ```json
 * { "tier": "free",
 *   "intelligence_index_version": "v4.3",
 *   "pagination": { "page": 1, "page_size": 25, "total_pages": 3, "has_more": true },
 *   "data": [ { "id": "…", "name": "…", "slug": "…", "release_date": "…",
 *               "model_creator": { "id": "…", "name": "…", "slug": "…" },
 *               "evaluations": { "…": 0 }, "pricing": { "price_1m_input_tokens": 0.15, "…": 0 },
 *               "performance": { "…": 0 } } ] }
 * ```
 *
 * **That exact response was never observed**: this module was written without an
 * AA API key, so every field below is read defensively and by several plausible
 * names. The names actually supported are the field lists in this module
 * (`SCORE_FIELDS`, `SPEED_FIELDS`, `LATENCY_FIELDS`, `PRICE_*_FIELDS`), each
 * additionally probed under `evaluations.`, `scores.`, `performance.` and
 * `pricing.` where that nesting could plausibly occur. Anything the endpoint
 * really returns under a name not on those lists is reported as `null` — never
 * as a guessed or zero value.
 *
 * Unknown numbers stay `null`; a documented zero (a token-plan route costing
 * nothing) stays `0`.
 *
 * @param {unknown} json Parsed JSON of one index page (or the whole envelope).
 * @returns {Array<{
 *   id: string|number|null,
 *   name: string|null,
 *   slug: string|null,
 *   modelCreator: string|null,
 *   scores: number|null,
 *   scoreName: string,
 *   tokensPerSecond: number|null,
 *   timeToFirstAnswerTokenSeconds: number|null,
 *   pricePer1M: { input: number|null, output: number|null, cacheRead: number|null }|null,
 *   contextWindow: number|null,
 *   generatedAt: string|null,
 * }>} Normalized entries; `[]` for anything unusable.
 */
export function parseAaFreeIndex(json) {
  try {
    const envelope = isRecord(json) ? json : null
    const rows = readIndexRows(json, envelope)
    if (rows.length === 0) return []

    const envelopeGeneratedAt = envelope === null ? null : readFirstString(envelope, GENERATED_AT_FIELDS)
    const out = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const creator = isRecord(row.model_creator)
        ? row.model_creator.name
        : row.model_creator ?? row.creator ?? row.modelCreator
      out.push({
        id: row.id ?? null,
        name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : null,
        slug: typeof row.slug === 'string' && row.slug.trim() !== '' ? row.slug.trim() : null,
        modelCreator: typeof creator === 'string' && creator.trim() !== '' ? creator.trim() : null,
        scores: readFirstNumber(row, SCORE_FIELDS, ['evaluations', 'scores', 'artificial_analysis']),
        scoreName: INTELLIGENCE_SCORE_NAME,
        tokensPerSecond: readFirstNumber(row, SPEED_FIELDS, ['performance', 'median_performance']),
        timeToFirstAnswerTokenSeconds: readFirstNumber(row, LATENCY_FIELDS, ['performance']),
        pricePer1M: readFlatPrice(row),
        contextWindow:
          parseTokenCount(row.context_window_tokens ?? row.contextWindowTokens ?? row.context_window) ??
          parseTokenCount(readPath(row, 'context_window.size')),
        generatedAt: readFirstString(row, GENERATED_AT_FIELDS) ?? envelopeGeneratedAt,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Parse a token count that AA may publish as a number or as display text.
 *
 * Accepts `1048576`, `"1048576"`, `"1,000,000"`, `"1M"`, `"1.0M"`, `"128K"`,
 * `"260k tokens"` and `"2B"`; returns a whole token count, or `null` for
 * anything else. Used for context windows and any other count AA renders
 * human-shortened.
 *
 * @param {unknown} value Candidate count.
 * @returns {number|null} Token count, or `null` when it cannot be read.
 */
export function parseTokenCount(value) {
  try {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
    }
    if (typeof value !== 'string') return null
    const text = value.trim().toLowerCase().replace(/,/g, '')
    if (text === '') return null
    const match = TOKEN_COUNT_RE.exec(text)
    if (match === null) return null
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return null
    const unit = (match[2] ?? '').toLowerCase()
    const scale = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1
    return Math.round(amount * scale)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// document helpers
// ---------------------------------------------------------------------------

/**
 * Parse every `application/ld+json` block; blocks that are not JSON are
 * dropped rather than failing the page.
 *
 * @param {string} html Page HTML.
 * @returns {unknown[]} Parsed block values.
 */
function extractJsonLd(html) {
  const values = []
  LD_JSON_RE.lastIndex = 0
  let match = LD_JSON_RE.exec(html)
  while (match !== null) {
    const raw = match[1]
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        values.push(JSON.parse(raw))
      } catch {
        // A malformed block is one lost metric, not a lost page.
      }
    }
    match = LD_JSON_RE.exec(html)
  }
  return values
}

/**
 * Project HTML onto its visible text: scripts and styles dropped, tags turned
 * into spaces, entities decoded, whitespace collapsed.
 *
 * @param {string} html Page HTML.
 * @returns {string} Visible text, single-spaced.
 */
function toVisibleText(html) {
  let text = html.replace(SCRIPT_RE, ' ').replace(STYLE_RE, ' ')
  text = text.replace(TAG_RE, ' ')
  return collapseWhitespace(decodeEntities(text))
}

/**
 * Read the canonical model slug from `<link rel="canonical">`, falling back to
 * `og:url`. The slug — not the page title — is what dataset `detailsUrl`
 * values are compared against.
 *
 * @param {string} html Page HTML.
 * @returns {string|null} Last path segment under `/models/`, or `null`.
 */
function readCanonicalSlug(html) {
  const href = readTagAttribute(html, LINK_TAG_RE, 'canonical') ?? readMetaContent(html, 'og:url')
  if (href === null) return null
  const path = href.split(/[?#]/)[0].replace(/\/+$/, '')
  const segments = path.split('/')
  const last = segments[segments.length - 1]
  if (typeof last !== 'string' || last === '') return null
  const decoded = safeDecodeURIComponent(last)
  // Reject a trailing non-model page (`/models/foo/providers`) by requiring the
  // canonical path to end in its own model segment.
  if (/^models$/i.test(decoded)) return null
  return decoded
}

/**
 * Read the model's display name: `og:title` with AA's page-title furniture
 * removed, else the `<h1>`, else any dataset entry label matching the slug.
 *
 * @param {string} html Page HTML.
 * @returns {string|null} Display name.
 */
function readPageName(html) {
  const ogTitle = readMetaContent(html, 'og:title')
  const fromOg = cleanPageTitle(ogTitle)
  if (fromOg !== null) return fromOg
  const h1 = H1_RE.exec(html)
  if (h1 !== null) {
    const fromH1 = cleanPageTitle(toVisibleText(h1[1]))
    if (fromH1 !== null) return fromH1
  }
  return null
}

/**
 * Strip AA's SEO title furniture (" - Intelligence, Performance & Price
 * Analysis | Artificial Analysis") from a page title.
 *
 * @param {string|null} value Raw title.
 * @returns {string|null} Bare model name.
 */
function cleanPageTitle(value) {
  if (typeof value !== 'string') return null
  let text = collapseWhitespace(decodeEntities(value))
  text = text.replace(/\s*[|\-–—]\s*Artificial Analysis\s*$/i, '')
  text = text.replace(/\s*[-–—]?\s*Intelligence,\s*Performance\s*&(?:amp;)?\s*Price Analysis\s*$/i, '')
  text = text.replace(/\s*[|\-–—]\s*Artificial Analysis\s*$/i, '')
  text = text.trim()
  return text === '' ? null : text
}

/**
 * Whether one leaderboard entry describes the page's model.
 *
 * `detailsUrl` is authoritative (it is AA's own link to the model page);
 * `label` is the fallback for datasets that omit it. Both are compared after
 * normalization, so `Qwen3.8-Flash-Next`, `qwen3-8-flash-next` and
 * `/models/qwen3-8-flash-next` all agree.
 *
 * @param {unknown} entry Candidate dataset entry.
 * @param {string|null} slug Canonical page slug.
 * @param {string|null} name Page display name.
 * @returns {boolean} True when the entry is this page's model.
 */
function entryBelongsToPage(entry, slug, name) {
  if (!isRecord(entry)) return false
  const detailsUrl = typeof entry.detailsUrl === 'string' ? entry.detailsUrl : ''
  if (detailsUrl !== '' && slug !== null) {
    const path = detailsUrl.split(/[?#]/)[0].replace(/\/+$/, '')
    const segments = path.split('/')
    const tail = safeDecodeURIComponent(segments[segments.length - 1] ?? '')
    if (normKey(tail) !== '' && normKey(tail) === normKey(slug)) return true
  }
  const label = typeof entry.label === 'string' ? entry.label : typeof entry.name === 'string' ? entry.name : ''
  if (label !== '' && name !== null && normKey(label) === normKey(name)) return true
  if (label !== '' && slug !== null && normKey(label) === normKey(slug)) return true
  return false
}

// ---------------------------------------------------------------------------
// metric readers
// ---------------------------------------------------------------------------

/**
 * Read the intelligence score from the Intelligence Index datasets.
 *
 * Only blocks that are *about* the intelligence index are considered: the
 * finance, openness and omniscience indices each carry their own `score`, and
 * taking the first numeric `score` on the page would silently report the wrong
 * benchmark.
 *
 * @param {Array<{ block: Record<string, unknown>, entry: Record<string, unknown> }>} matched Matched entries.
 * @returns {{ value: number, name: string }|null} Score and its metric name.
 */
function readScore(matched) {
  let fallback = null
  for (const { block, entry } of matched) {
    if (!isIntelligenceBlock(block)) continue
    for (const field of SCORE_FIELDS) {
      const value = toNumber(entry[field])
      if (value === null) continue
      const name = intelligenceScoreName(block) ?? INTELLIGENCE_SCORE_NAME
      // `intelligenceIndex`/`artificialAnalysisIntelligenceIndex` are exact;
      // a bare `score` is only trusted when nothing better exists.
      if (field === 'score') {
        if (fallback === null) fallback = { value, name }
        continue
      }
      return { value, name }
    }
  }
  return fallback
}

/**
 * Whether a dataset block reports the Artificial Analysis Intelligence Index.
 *
 * @param {Record<string, unknown>} block Dataset block.
 * @returns {boolean} True for intelligence-index blocks.
 */
function isIntelligenceBlock(block) {
  const text = `${typeof block.name === 'string' ? block.name : ''} ${typeof block.description === 'string' ? block.description : ''}`
  return /intelligence\s+index/i.test(text) || /^intelligence$/i.test(String(block.name ?? '').trim())
}

/**
 * The index's own name as the block states it, e.g. "Artificial Analysis
 * Intelligence Index".
 *
 * @param {Record<string, unknown>} block Dataset block.
 * @returns {string|null} Metric name, or `null` when the block does not name it.
 */
function intelligenceScoreName(block) {
  for (const candidate of [block.name, block.description]) {
    if (typeof candidate !== 'string') continue
    const at = candidate.toLowerCase().indexOf('intelligence index')
    if (at < 0) continue
    const name = collapseWhitespace(candidate.slice(0, at + 'intelligence index'.length)).trim()
    if (name !== '') return name
  }
  return null
}

/**
 * The index version AA states in its own prose, e.g. `v4.3` from "Artificial
 * Analysis Intelligence Index v4.3 incorporates 10 evaluations: …".
 *
 * @param {unknown[]} datasets Parsed Dataset blocks.
 * @returns {string|null} Version string including its `v`, or `null`.
 */
function readScoreVersion(datasets) {
  for (const block of datasets) {
    for (const text of collectStrings(block)) {
      const match = /intelligence\s+index\s+v(\d+(?:\.\d+)*)/i.exec(text)
      if (match !== null) return `v${match[1]}`
    }
  }
  return null
}

/**
 * Output speed in tokens per second, from any entry on the page.
 *
 * @param {Array<{ entry: Record<string, unknown> }>} matched Matched entries.
 * @returns {number|null} Tokens per second.
 */
function readSpeed(matched) {
  for (const field of SPEED_FIELDS) {
    for (const { entry } of matched) {
      const value = toNumber(entry[field])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * Whether a dataset is the one that measures time to first ANSWER token.
 *
 * Selection is by metric IDENTITY, never by "the first numeric field found".
 * AA's page carries several time-shaped datasets whose entries reuse the field
 * names `inputTime` / `reasoningTime`, and only one of them is TTFT:
 *
 *   - `Latency: Time To First Answer Token` — the metric wanted here. Its
 *     `inputTime` is the TTFT; `reasoningTime` is the model's thinking time,
 *     charted beside it.
 *   - `End-to-End Response Time` — same two fields, same values, but it answers
 *     "how long to emit 500 tokens", not TTFT.
 *   - `Time per Intelligence Index Task` / `Cost per (Intelligence Index) Task`
 *     / `Output Tokens per Intelligence Index Task` — per-task aggregates with
 *     no TTFT meaning at all.
 *
 * Matching the name first and excluding those neighbours is what keeps the
 * number honest; a page-order or first-match rule silently reports the wrong
 * metric (observed: 38.95 instead of 2.89, the sum of TTFT and thinking time).
 *
 * @param {Record<string, unknown>} block Parsed `Dataset` block.
 * @returns {boolean} True when the block's own text names TTFT.
 */
function isTimeToFirstAnswerTokenBlock(block) {
  const name = String(block?.name ?? '')
  if (name === '') return false
  if (TTFT_EXCLUDED_BLOCK_RE.test(name)) return false
  return TTFT_BLOCK_RE.test(name)
}

/**
 * Time to first ANSWER token, in seconds.
 *
 * The value comes from the block identified by
 * {@link isTimeToFirstAnswerTokenBlock}: an explicit answer-token field when AA
 * publishes one, otherwise that block's `inputTime` — the input processing
 * time, which is what AA's own prose means by "a time to first token (TTFT) of
 * 2.89s".
 *
 * Only the number is returned. The thinking time charted beside it is
 * deliberately NOT folded in (that would turn a 2.9s TTFT into the 38.9s
 * answer-token latency the page also publishes) and deliberately not returned
 * alongside it: the field this feeds is typed `number|null`, and a value that
 * silently varied between a number and an object would defeat every consumer's
 * null check.
 *
 * @param {Array<{ block: Record<string, unknown>, entry: Record<string, unknown> }>} matched Matched entries.
 * @returns {number|null} Seconds, or `null` when AA measured no TTFT.
 */
function readAnswerTokenLatency(matched) {
  const blocks = matched.filter(({ block }) => isTimeToFirstAnswerTokenBlock(block))
  for (const field of LATENCY_FIELDS) {
    for (const { entry } of blocks) {
      const value = toNumber(entry[field])
      if (value !== null) return value
    }
  }
  for (const { entry } of blocks) {
    const input = toNumber(entry.inputTime ?? entry.input_time)
    if (input !== null) return input
  }
  // A latency block that carries only the thinking time measured no TTFT, so
  // this is "not measured" rather than a zero-second first token.
  return null
}

/**
 * The thinking time published beside the TTFT, in seconds.
 *
 * @param {Array<{ entry: Record<string, unknown> }>} blocks TTFT-matched entries.
 * @returns {number|null} Seconds, or `null` when AA published none.
 */
function reasoningTimeOf(blocks) {
  for (const { entry } of blocks) {
    const value = toNumber(entry.reasoningTime ?? entry.reasoning_time)
    if (value !== null) return value
  }
  return null
}

/**
 * USD per 1M tokens, from the pricing dataset or from explicit flat price
 * fields anywhere on the page.
 *
 * @param {Array<{ block: Record<string, unknown>, entry: Record<string, unknown> }>} matched Matched entries.
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null }} Prices.
 */
function readPrice(matched) {
  const price = { input: null, output: null, cacheRead: null }
  for (const { entry } of matched) {
    // AA's pricing dataset nests `[{ @type: 'PropertyValue', name, value }]`.
    if (Array.isArray(entry.pricing)) {
      for (const row of entry.pricing) {
        if (!isRecord(row)) continue
        const label = typeof row.name === 'string' ? row.name.toLowerCase() : ''
        const value = toNumber(row.value)
        if (value === null || label === '') continue
        if (label.includes('cache') && (label.includes('hit') || label.includes('read'))) price.cacheRead ??= value
        else if (label.includes('output')) price.output ??= value
        else if (label.includes('input')) price.input ??= value
      }
    }
    // …and some payloads carry the same three prices as flat fields.
    price.input ??= readFirstNumber(entry, PRICE_INPUT_FIELDS, ['pricing'])
    price.output ??= readFirstNumber(entry, PRICE_OUTPUT_FIELDS, ['pricing'])
    price.cacheRead ??= readFirstNumber(entry, PRICE_CACHE_FIELDS, ['pricing'])
  }
  return price
}

/**
 * Context window in tokens, from the Context Window dataset.
 *
 * @param {Array<{ block: Record<string, unknown>, entry: Record<string, unknown> }>} matched Matched entries.
 * @returns {number|null} Tokens, or `null` when the model is not on that chart.
 */
function readContextWindow(matched) {
  for (const { block, entry } of matched) {
    if (!/context\s*window/i.test(String(block.name ?? ''))) continue
    for (const field of ['contextWindowTokens', 'contextWindow', 'contextWindowSize', 'value', 'tokens']) {
      const value = parseTokenCount(entry[field])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * Context window read from the page's own FAQ prose — the documented fallback
 * for a model that is absent from the Context Window leaderboard slice. AA
 * rounds there ("260k tokens"), so prefer the dataset whenever it has the model.
 *
 * @param {unknown[]} blocks Parsed ld+json blocks.
 * @returns {number|null} Tokens, or `null`.
 */
function readFaqContextWindow(blocks) {
  for (const block of blocks) {
    const questions = isRecord(block) && Array.isArray(block.mainEntity) ? block.mainEntity : []
    for (const question of questions) {
      if (!isRecord(question)) continue
      const answer = isRecord(question.acceptedAnswer) ? question.acceptedAnswer.text : undefined
      const text = `${typeof question.name === 'string' ? question.name : ''} ${typeof answer === 'string' ? answer : ''}`
      if (!/context\s*window/i.test(text)) continue
      const match = /context\s*window\s*of\s*([0-9][0-9.,]*\s*[kmbKMB]?)/.exec(text)
      if (match === null) continue
      const value = parseTokenCount(match[1])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * Model creator: the FAQ's own sentence ("Qwen3.8-Flash-Next was created by
 * Alibaba."), else the `og:description` possessive sentence ("Analysis of
 * Alibaba's …" / "Analysis of Fixture Labs' …").
 *
 * @param {unknown[]} blocks Parsed ld+json blocks.
 * @param {string} html Page HTML, for the meta fallback.
 * @param {string|null} modelName Page model name, stripped from a possessive creator sentence.
 * @returns {string|null} Creator name.
 */
function readCreator(blocks, html, modelName) {
  for (const block of blocks) {
    const questions = isRecord(block) && Array.isArray(block.mainEntity) ? block.mainEntity : []
    for (const question of questions) {
      if (!isRecord(question)) continue
      const answer = isRecord(question.acceptedAnswer) ? question.acceptedAnswer.text : undefined
      if (typeof answer !== 'string') continue
      const match = /created\s+by\s+([^.,;(]{1,60})/i.exec(answer)
      if (match === null) continue
      const creator = collapseWhitespace(match[1]).trim()
      if (creator !== '') return creator
    }
  }
  const description = readMetaContent(html, 'og:description')
  if (description === null) return null
  // The possessive fence is the apostrophe itself. Reading up to `'s` only
  // works for "Analysis of Alibaba's Qwen…"; the equally common
  // "Analysis of Fixture Labs' Test-Model-A" — a multi-word creator whose model
  // name follows the possessive — needs the suffix split off instead. Both are
  // attempted, longest first, and the answer is trimmed to the creator alone.
  const possessive = /analysis\s+of\s+([^,.;:]{1,60}?)'s?\s+/i.exec(description)
  if (possessive === null) return null
  let creator = collapseWhitespace(possessive[1]).trim()
  const suffix =
    typeof modelName === 'string' && modelName !== '' && creator.endsWith(modelName)
      ? creator.slice(0, creator.length - modelName.length).trim()
      : creator
  if (suffix !== '') creator = suffix
  return creator === '' ? null : creator
}

/**
 * Leaderboard position text.
 *
 * **`rank` is deliberately always `null`.** AA's model pages do print text of
 * the shape "27 of 653 models", but probing showed it is a model-picker counter
 * rather than a rank: the same "27 of 653 models" (and "26 of 161", "27 of
 * 170", "27 of 528") appears on the page of the index leader (Claude Fable 5.1,
 * score 53.4) and on the page of a far weaker model, and it is repeated
 * unchanged in the Intelligence, Speed and Latency sections of one page. The
 * only thing such text reliably states is how many models AA tracks, which is
 * reported as `ofCount`. A future page that spells a rank out ("Ranked 27 of
 * 653") is still read.
 *
 * @param {string} text Visible page text.
 * @returns {{ rank: number|null, ofCount: number|null }} Rank facts.
 */
function extractRankAndCount(text) {
  const explicit = /(?:rank(?:ed)?|position)\s*#?\s*(\d{1,5})\s*(?:of|\/)\s*([\d,]+)/i.exec(text)
  const counter = /\b(\d{1,5})\s+of\s+([\d,]+)\s+models\b/i.exec(text)
  return {
    rank: explicit === null ? null : toNumber(explicit[1]),
    ofCount: counter === null ? null : toNumber(counter[2]),
  }
}

/**
 * First `dateModified` / `datePublished` (or equivalent) value found anywhere
 * in the blocks. AA's current pages carry none, so this normally returns
 * `null`.
 *
 * @param {unknown[]} blocks Parsed ld+json blocks.
 * @returns {string|null} ISO-8601 timestamp.
 */
function readGeneratedAt(blocks) {
  for (const block of blocks) {
    const found = findDateValue(block, 0)
    if (found !== null) return found
  }
  return null
}

/**
 * Depth-bounded search for a date-valued field.
 *
 * @param {unknown} value Any JSON value.
 * @param {number} depth Current depth.
 * @returns {string|null} ISO-8601 timestamp.
 */
function findDateValue(value, depth) {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDateValue(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const field of GENERATED_AT_FIELDS) {
    const candidate = value[field]
    if (typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(candidate.trim())) return candidate.trim()
  }
  for (const item of Object.values(value)) {
    const found = findDateValue(item, depth + 1)
    if (found !== null) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// generic readers
// ---------------------------------------------------------------------------

/**
 * First finite number among `fields` on `row`, also probing the documented
 * nested containers.
 *
 * @param {Record<string, unknown>} row Source row.
 * @param {string[]} fields Candidate field names, in priority order.
 * @param {string[]} [containers] Nested objects to probe as well.
 * @returns {number|null} Value, or `null`.
 */
function readFirstNumber(row, fields, containers = []) {
  for (const field of fields) {
    const direct = toNumber(row[field])
    if (direct !== null) return direct
  }
  for (const container of containers) {
    const nested = row[container]
    if (!isRecord(nested)) continue
    for (const field of fields) {
      const value = toNumber(nested[field])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * First non-empty string among `fields` on `row`.
 *
 * @param {Record<string, unknown>} row Source row.
 * @param {string[]} fields Candidate field names, in priority order.
 * @returns {string|null} Value, or `null`.
 */
function readFirstString(row, fields) {
  for (const field of fields) {
    const value = row[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Prices from flat fields, or `null` when the payload carries none at all.
 *
 * @param {Record<string, unknown>} row Source row.
 * @returns {{ input: number|null, output: number|null, cacheRead: number|null }|null} Prices.
 */
function readFlatPrice(row) {
  const price = {
    input: readFirstNumber(row, PRICE_INPUT_FIELDS, ['pricing']),
    output: readFirstNumber(row, PRICE_OUTPUT_FIELDS, ['pricing']),
    cacheRead: readFirstNumber(row, PRICE_CACHE_FIELDS, ['pricing']),
  }
  if (price.input === null && price.output === null && price.cacheRead === null) return null
  return price
}

/**
 * Read a dotted path, tolerating missing intermediate objects.
 *
 * @param {unknown} value Root value.
 * @param {string} path Dot-separated path.
 * @returns {unknown} Value at the path, or `undefined`.
 */
function readPath(value, path) {
  let current = value
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * The entry array of an index response: the documented `data` array, or a
 * defensively probed alternative, or the value itself when it already is one.
 *
 * @param {unknown} json Whole response.
 * @param {Record<string, unknown>|null} envelope Response as a record.
 * @returns {unknown[]} Candidate rows.
 */
function readIndexRows(json, envelope) {
  if (Array.isArray(json)) return json
  if (envelope === null) return []
  for (const key of INDEX_ENTRY_KEYS) {
    if (Array.isArray(envelope[key])) return envelope[key]
  }
  return []
}

/**
 * Read a `<link>`'s `href` by its `rel` value, tolerating attribute order.
 *
 * @param {string} html Page HTML.
 * @param {RegExp} tagRe Global tag pattern.
 * @param {string} relValue Required `rel` value, case-insensitive.
 * @returns {string|null} Attribute value, or `null`.
 */
function readTagAttribute(html, tagRe, relValue) {
  tagRe.lastIndex = 0
  let tag = tagRe.exec(html)
  while (tag !== null) {
    const text = tag[0]
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(text)
    if (rel !== null && rel[1].toLowerCase() === relValue.toLowerCase()) {
      const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(text) ?? /\bhref\s*=\s*([^\s>]+)/i.exec(text)
      if (href !== null) return decodeEntities(href[1]).trim()
    }
    tag = tagRe.exec(html)
  }
  return null
}

/**
 * Read a `<meta property="…">` (or `name="…"`) content value, tolerating
 * attribute order.
 *
 * @param {string} html Page HTML.
 * @param {string} key Property or name to match.
 * @returns {string|null} Decoded content, or `null`.
 */
function readMetaContent(html, key) {
  META_TAG_RE.lastIndex = 0
  let tag = META_TAG_RE.exec(html)
  while (tag !== null) {
    const text = tag[0]
    const prop = /\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(text)
    if (prop !== null && prop[1].toLowerCase() === key.toLowerCase()) {
      // The character class excludes only the quote that actually opened the
      // attribute: a double-quoted `content="Alibaba's Qwen"` is a literal
      // apostrophe inside the value, not its terminator, and truncating there
      // would silently return half a model name.
      const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text)
      if (content !== null) {
        const decoded = collapseWhitespace(decodeEntities(content[1] ?? content[2] ?? ''))
        if (decoded !== '') return decoded
      }
    }
    tag = META_TAG_RE.exec(html)
  }
  return null
}

// ---------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a JSON value to a finite number.
 *
 * Accepts numbers and numeric strings, including display forms with currency
 * symbols, thousands separators and trailing units (`"$0.15"`, `"1,000,000"`,
 * `"55.5 t/s"`). Returns `null` — never `0` — for anything unreadable, and
 * preserves a genuine `0`.
 *
 * @param {unknown} value Candidate value.
 * @returns {number|null} Finite number, or `null`.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[,\s$€£]/g, '')
  if (cleaned === '') return null
  const match = NUMBER_PREFIX_RE.exec(cleaned)
  if (match === null) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Collect every string inside a JSON value, depth-bounded.
 *
 * @param {unknown} value Any JSON value.
 * @param {string[]} [out] Accumulator.
 * @param {number} [depth] Current depth.
 * @returns {string[]} Strings found.
 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return out
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1)
  }
  return out
}

/**
 * Comparison key for slugs, labels and names: lowercase, alphanumerics only.
 *
 * @param {unknown} value Candidate text.
 * @returns {string} Normalized key.
 */
function normKey(value) {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Collapse whitespace runs to single spaces.
 *
 * @param {string} value Text.
 * @returns {string} Single-spaced text.
 */
function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Decode the HTML entities AA's markup actually uses.
 *
 * @param {string} value Text.
 * @returns {string} Decoded text.
 */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/**
 * Encode a code point, falling back to the raw input for invalid values.
 *
 * @param {number} codePoint Code point.
 * @returns {string} Single character.
 */
function safeCodePoint(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return ''
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ''
  }
}

/**
 * Percent-decode a URL segment without throwing on malformed input.
 *
 * @param {string} value Encoded segment.
 * @returns {string} Decoded segment.
 */
function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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

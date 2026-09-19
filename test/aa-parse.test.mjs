/* Pure parsing of Artificial Analysis (AA) payloads.
 *
 * FIXTURE POLICY — every payload in this file is synthetic. The model name
 * (`Test-Model-A`), the creator (`Fixture Labs`), the score (41.25), the prices
 * and the timings were invented here. No content from an Artificial Analysis
 * page is copied into this repository, because AA's Data Platform Terms forbid
 * redistribution; the fixtures reproduce only the *structure* that
 * `lib/aa/parse.js` consumes, which is exactly the contract this file pins.
 *
 * The two properties worth protecting, and the reason for the shape of these
 * tests:
 *
 *   1. every parser is TOTAL — a 404 shell, broken JSON, `null`, `42` or a
 *      deeply nested object must yield `null` / `[]`, never a throw, because
 *      the caller treats "no profile" and "AA is broken" identically;
 *   2. an ABSENT measurement is `null`, never `0`, while a *genuine* `0` (a
 *      token-plan route really does cost nothing) stays `0`. Rendering an
 *      absent price as "$0.00" would tell the model that delegation is free.
 *
 * Offline and I/O-free: `lib/aa/parse.js` imports nothing at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseAaModelPage, parseAaFreeIndex, parseTokenCount } from '../lib/aa/parse.js'

/** The invented model every page fixture is about. */
const SLUG = 'test-model-a'
const NAME = 'Test-Model-A'

/** AA's own name for the index, as `lib/aa/parse.js` reports it. */
const SCORE_NAME = 'Artificial Analysis Intelligence Index'

/**
 * The TTFT a parsed page reports.
 *
 * OBSERVED, and inconsistent with the module's own JSDoc: `parseAaModelPage`
 * documents `timeToFirstAnswerTokenSeconds` as `number|null`, but it currently
 * stores the whole `readAnswerTokenLatency()` result — always an object shaped
 * `{ ttft, reasoning }`, with `ttft: null` when unmeasured. This reader accepts
 * either shape, so the *value* every assertion below pins (which metric, from
 * which block) holds whichever shape `lib/` ships; the shape itself is recorded
 * by the dedicated latency-shape test and reported as a defect.
 *
 * @param {object|null} page Parsed page.
 * @returns {number|null} Seconds to first answer token.
 */
function ttftOf(page) {
  const value = page?.timeToFirstAnswerTokenSeconds
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  return typeof value.ttft === 'number' ? value.ttft : null
}

/**
 * The thinking time charted beside the TTFT, when the page reports it.
 *
 * @param {object|null} page Parsed page.
 * @returns {number|null} Seconds, or `null` when absent or reported as a bare number.
 */
function reasoningOf(page) {
  const value = page?.timeToFirstAnswerTokenSeconds
  if (value === null || typeof value !== 'object') return null
  return typeof value.reasoning === 'number' ? value.reasoning : null
}

/* ------------------------------------------------------------------ */
/* synthetic document builders                                         */
/* ------------------------------------------------------------------ */

/**
 * One `<script type="application/ld+json">…</script>` element.
 *
 * @param {string} json Raw script body (already serialized).
 * @param {{ attrs?: string, pad?: string, close?: string }} [options] Tag shape.
 * @returns {string} Script element.
 */
function ld(json, options = {}) {
  const attrs = options.attrs ?? 'type="application/ld+json"'
  const pad = options.pad ?? ''
  const close = options.close ?? '</script>'
  return `<script ${attrs}>${pad}${json}${pad}${close}`
}

/**
 * One schema.org `Dataset` block: a named metric plus its leaderboard slice.
 *
 * @param {string} name Dataset name.
 * @param {Record<string, unknown>} entry Metric fields on the page's own entry.
 * @param {string} [description] Dataset description.
 * @returns {Record<string, unknown>} Block.
 */
function dataset(name, entry, description) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name,
    ...(description === undefined ? {} : { description }),
    data: [{ '@type': 'Thing', label: NAME, detailsUrl: `/models/${SLUG}`, ...entry }],
  }
}

const scoreBlock = (entry) =>
  dataset(
    SCORE_NAME,
    entry ?? { intelligenceIndex: 41.25 },
    'Artificial Analysis Intelligence Index v9.9 incorporates 10 evaluations: synthetic fixture text.',
  )
const speedBlock = (entry) => dataset('Output Speed', entry ?? { medianOutputTokensPerSecond: 88.5 })
const latencyBlock = (entry) =>
  dataset(
    'Latency: Time To First Answer Token',
    entry ?? { inputTime: 0.42, reasoningTime: 12.5 },
    "Seconds to first answer token received · Accounts for reasoning model 'thinking' time",
  )
/** The look-alike dataset whose entries reuse `inputTime`/`reasoningTime`. */
const endToEndBlock = (entry) => dataset('End-to-End Response Time', entry ?? { inputTime: 0.42, reasoningTime: 12.5 })
/** Per-task *cost* fields, which are not USD per 1M tokens. */
const costBlock = () => dataset('Cost per Intelligence Index Task', { input: 0.02, cacheHit: 0.01, output: 3.1 })
const priceBlock = (rows) =>
  dataset('Pricing: USD per 1M tokens', {
    pricing:
      rows ??
      [
        { '@type': 'PropertyValue', name: 'Input Price', value: 0.15 },
        { name: 'Output Price', value: 0.6 },
        { name: 'Cache Hit Price', value: 0.05 },
      ],
  })
const contextBlock = (entry) => dataset('Context Window', entry ?? { contextWindowTokens: '131,072' })

/** The prose block (not a Dataset) the parser reads for creator + FAQ fallback. */
const FAQ_BLOCK = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: `What is the context window of ${NAME}?`,
      acceptedAnswer: { '@type': 'Answer', text: `${NAME} has a context window of 260k tokens.` },
    },
    {
      '@type': 'Question',
      name: `Who created ${NAME}?`,
      acceptedAnswer: { '@type': 'Answer', text: `${NAME} was created by Fixture Labs.` },
    },
  ],
}

/** The standard metric set, in page order; `include` switches any one off. */
const STANDARD = {
  score: scoreBlock,
  speed: speedBlock,
  latency: latencyBlock,
  endToEnd: endToEndBlock,
  cost: costBlock,
  price: priceBlock,
  context: contextBlock,
  faq: () => FAQ_BLOCK,
}

/**
 * Build a synthetic model page.
 *
 * @param {object} [options] Page options.
 * @param {Record<string, boolean>} [options.include] `false` drops that block.
 * @param {Record<string, unknown|string>} [options.blocks] Per-block override;
 *   a *string* is used verbatim as the script body (for malformed JSON).
 * @param {{ canonical?: string|null, ogTitle?: string|null, ogDescription?: string|null, h1?: string|null, links?: string, extra?: string }} [options.head] Head parts; `extra` is inserted verbatim.
 * @param {{ attrs?: string, pad?: string, close?: string }} [options.script] Script tag shape for every block.
 * @param {string} [options.body] Extra visible body HTML.
 * @returns {string} Page HTML.
 */
function pageHtml(options = {}) {
  const { include = {}, blocks = {}, head = {}, script = {}, body = '' } = options

  const parts = []
  for (const [key, factory] of Object.entries(STANDARD)) {
    if (include[key] === false) continue
    const value = Object.hasOwn(blocks, key) ? blocks[key] : factory()
    parts.push(ld(typeof value === 'string' ? value : JSON.stringify(value), script))
  }

  const canonical =
    head.canonical === undefined
      ? `<link rel="canonical" href="https://artificialanalysis.ai/models/${SLUG}">`
      : head.canonical === null
        ? ''
        : head.canonical
  const ogTitle =
    head.ogTitle === undefined
      ? `${NAME} - Intelligence, Performance &amp; Price Analysis | Artificial Analysis`
      : head.ogTitle === null
        ? ''
        : head.ogTitle
  const ogDescription =
    head.ogDescription === undefined ? '' : head.ogDescription === null ? '' : head.ogDescription
  const h1 = head.h1 === undefined ? `<h1>${NAME}</h1>` : head.h1 === null ? '' : head.h1

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    head.links ?? '',
    head.extra ?? '',
    canonical,
    ogTitle === '' ? '' : `<meta property="og:title" content="${ogTitle}">`,
    ogDescription === '' ? '' : `<meta property="og:description" content="${ogDescription}">`,
    `<title>${NAME}</title></head><body>`,
    h1,
    body,
    parts.join(''),
    '</body></html>',
  ].join('')
}

/** The standard, fully-measured page. */
const STANDARD_PAGE = pageHtml()

/* ------------------------------------------------------------------ */
/* well-formed page                                                    */
/* ------------------------------------------------------------------ */

test('a well-formed page yields every measurement it carries', () => {
  const page = parseAaModelPage(STANDARD_PAGE)
  assert.notEqual(page, null)

  assert.equal(page.name, NAME)
  assert.equal(page.slug, SLUG)
  assert.equal(page.creator, 'Fixture Labs')

  assert.equal(page.scores, 41.25)
  assert.equal(page.scoreName, SCORE_NAME)
  assert.equal(page.scoreVersion, 'v9.9')

  assert.equal(page.tokensPerSecond, 88.5)
  assert.equal(ttftOf(page), 0.42)

  assert.deepEqual(page.pricePer1M, { input: 0.15, output: 0.6, cacheRead: 0.05 })
  assert.equal(page.contextWindow, 131072)

  // AA publishes neither a per-model rank nor a generation timestamp on these
  // pages, so both stay unknown rather than guessed.
  assert.equal(page.rank, null)
  assert.equal(page.ofCount, null)
  assert.equal(page.generatedAt, null)
})

test('the page-title furniture is stripped down to the bare model name', () => {
  const page = parseAaModelPage(pageHtml())
  assert.equal(page.name, NAME)

  const fromPipe = parseAaModelPage(pageHtml({ head: { ogTitle: `${NAME} | Artificial Analysis` } }))
  assert.equal(fromPipe.name, NAME)

  const fromH1 = parseAaModelPage(pageHtml({ head: { ogTitle: null, h1: `<h1>${NAME}</h1>` } }))
  assert.equal(fromH1.name, NAME, 'the h1 answers when og:title is absent')
})

test('the canonical link supplies the slug the dataset entries are matched against', () => {
  const page = parseAaModelPage(STANDARD_PAGE)
  assert.equal(page.slug, SLUG)

  // og:url is the documented fallback when there is no canonical link.
  const viaOgUrl = parseAaModelPage(
    pageHtml({
      head: {
        canonical: null,
        links: `<meta property="og:url" content="https://artificialanalysis.ai/models/${SLUG}">`,
      },
    }),
  )
  assert.equal(viaOgUrl.slug, SLUG)
})

test('a dataset entry labelled with the page name still matches without a detailsUrl', () => {
  const block = dataset('Output Speed', { medianOutputTokensPerSecond: 77 })
  delete block.data[0].detailsUrl
  const page = parseAaModelPage(pageHtml({ include: { score: false, latency: false, price: false, context: false }, blocks: { speed: block } }))
  assert.equal(page.tokensPerSecond, 77)
})

test('the FAQ prose supplies the context window when the model is off that chart', () => {
  // The Context Window dataset is a leaderboard slice: a 260k model can be
  // absent from a chart of 1M-context leaders, and AA's own prose is then the
  // documented fallback.
  const page = parseAaModelPage(pageHtml({ include: { context: false } }))
  assert.equal(page.contextWindow, 260000)

  // …and the dataset wins whenever it does carry the model.
  assert.equal(parseAaModelPage(STANDARD_PAGE).contextWindow, 131072)
})

test('the og:description sentence supplies the creator when the FAQ does not', () => {
  // The possessive is entity-escaped here, which is the only spelling the
  // parser can read — see the limitation test below.
  const page = parseAaModelPage(
    pageHtml({
      include: { faq: false },
      head: { ogDescription: `Analysis of Fixture Labs&#39;s ${NAME}, a synthetic fixture.` },
    }),
  )
  assert.equal(page.creator, 'Fixture Labs')
  assert.equal(parseAaModelPage(pageHtml({ include: { faq: false } })).creator, null)
})

test('an unescaped apostrophe inside a meta attribute is kept, not truncated', () => {
  // `readMetaContent` matches the quote that actually opened the attribute, so a
  // literal apostrophe inside a double-quoted value is content rather than a
  // terminator. The creator sentence this fallback exists for is possessive
  // ("Analysis of Alibaba's …"), and real markup carries the bare character as
  // often as the entity, so both spellings must read identically.
  const literal = pageHtml({
    include: { faq: false },
    head: { ogDescription: `Analysis of Fixture Labs' ${NAME}, a synthetic fixture.` },
  })
  assert.equal(parseAaModelPage(literal).creator, 'Fixture Labs')

  // A possessive og:title must not be cut short at the apostrophe either.
  const possessiveTitle = pageHtml({ head: { ogTitle: `Fixture Labs' ${NAME} | Artificial Analysis` } })
  assert.equal(parseAaModelPage(possessiveTitle).name, `Fixture Labs' ${NAME}`)
})

test('the "N of M models" counter becomes ofCount and never a rank', () => {
  // Probing AA showed the counter is a model-picker count, repeated unchanged
  // on the index leader and on far weaker models, so it must never be a rank.
  const page = parseAaModelPage(pageHtml({ body: '<p>Filters: 27 of 653 models</p>' }))
  assert.equal(page.ofCount, 653)
  assert.equal(page.rank, null)
})

test('a spelled-out rank is read when a page really states one', () => {
  const page = parseAaModelPage(pageHtml({ body: '<p>Ranked 3 of 653 models</p>' }))
  assert.equal(page.rank, 3)
  assert.equal(page.ofCount, 653)
})

test('generatedAt is read from a date field anywhere in the blocks', () => {
  const dated = { ...FAQ_BLOCK, datePublished: '2025-01-02T03:04:05Z' }
  const page = parseAaModelPage(pageHtml({ blocks: { faq: dated } }))
  assert.equal(page.generatedAt, '2025-01-02T03:04:05Z')
})

/* ------------------------------------------------------------------ */
/* tolerance: tag shape, attribute order, JSON key order                */
/* ------------------------------------------------------------------ */

test('the same blocks read identically with attributes reordered and extra attributes present', () => {
  const variants = [
    pageHtml(),
    pageHtml({ script: { attrs: 'nonce="n0" type=\'application/ld+json\' data-block="metric"', pad: '\n  ', close: '</script >' } }),
    pageHtml({ script: { attrs: 'type="application/ld+json" nonce="n0"', pad: '\n\n', close: '</script\n>' } }),
  ]
  const [plain, singleQuoted, padded] = variants.map((html) => parseAaModelPage(html))
  for (const variant of [singleQuoted, padded]) {
    assert.deepEqual(variant, plain, 'tag shape and </script>-adjacent whitespace must not matter')
  }
  assert.equal(plain.scores, 41.25)
})

test('link and meta attributes are read in either order, quoted or not', () => {
  const variants = [
    `<link rel="canonical" href="https://artificialanalysis.ai/models/${SLUG}">`,
    `<link href="https://artificialanalysis.ai/models/${SLUG}" rel="canonical">`,
    `<link rel=canonical href=https://artificialanalysis.ai/models/${SLUG}>`,
    `<link rel="preload" href="https://artificialanalysis.ai/static/app.js"><link href="https://artificialanalysis.ai/models/${SLUG}" rel="canonical">`,
  ]
  for (const canonical of variants) {
    assert.equal(parseAaModelPage(pageHtml({ head: { canonical } })).slug, SLUG, canonical)
  }

  const metaVariants = [
    `<meta property="og:title" content="${NAME} | Artificial Analysis">`,
    `<meta content="${NAME} | Artificial Analysis" property="og:title">`,
    `<meta name="og:title" content="${NAME} | Artificial Analysis">`,
  ]
  for (const meta of metaVariants) {
    const page = parseAaModelPage(pageHtml({ head: { ogTitle: null, extra: meta } }))
    assert.equal(page.name, NAME, meta)
  }
})

test('a percent-encoded canonical slug still matches the dataset entry', () => {
  const encoded = pageHtml({
    head: { canonical: '<link rel="canonical" href="https://artificialanalysis.ai/models/test%2Dmodel%2Da">' },
  })
  assert.equal(parseAaModelPage(encoded).slug, SLUG)
})

test('pricing rows are read by label, so their order in the array does not matter', () => {
  const rows = [
    { name: 'Cache Hit Price', value: 0.05 },
    { name: 'Input Price', value: 0.15 },
    { name: 'Output Price', value: 0.6 },
  ]
  const shuffled = parseAaModelPage(pageHtml({ blocks: { price: priceBlock([rows[2], rows[0], rows[1]]) } }))
  assert.deepEqual(shuffled.pricePer1M, { input: 0.15, output: 0.6, cacheRead: 0.05 })
  assert.deepEqual(shuffled.pricePer1M, parseAaModelPage(STANDARD_PAGE).pricePer1M)
})

test('display-form numbers are read like numbers', () => {
  const page = parseAaModelPage(
    pageHtml({
      blocks: {
        score: scoreBlock({ intelligenceIndex: '41.25' }),
        speed: speedBlock({ medianOutputTokensPerSecond: '88.5 t/s' }),
        latency: latencyBlock({ inputTime: '0.42', reasoningTime: 12.5 }),
        price: priceBlock([
          { name: 'Input Price', value: '$0.15' },
          { name: 'Output Price', value: '0.60' },
          { name: 'Cache Hit Price', value: '1,000' },
        ]),
        context: contextBlock({ contextWindowTokens: '260k tokens' }),
      },
    }),
  )
  assert.equal(page.scores, 41.25)
  assert.equal(page.tokensPerSecond, 88.5)
  assert.equal(ttftOf(page), 0.42)
  assert.deepEqual(page.pricePer1M, { input: 0.15, output: 0.6, cacheRead: 1000 })
  assert.equal(page.contextWindow, 260000)
})

/* ------------------------------------------------------------------ */
/* metric identity                                                     */
/* ------------------------------------------------------------------ */

test('the latency number comes from the answer-token block, not from its look-alikes', () => {
  // `End-to-End Response Time` reuses inputTime/reasoningTime with the same
  // values; summing them (or reading the wrong block) overstates TTFT by an
  // order of magnitude. Both blocks are present here on purpose.
  const page = parseAaModelPage(pageHtml())
  assert.equal(ttftOf(page), 0.42, 'the latency block wins, and it is not the sum')
  assert.notEqual(ttftOf(page), 12.92, 'and it is not inputTime + reasoningTime')

  const onlyEndToEnd = parseAaModelPage(pageHtml({ include: { latency: false } }))
  assert.equal(ttftOf(onlyEndToEnd), null, 'the look-alike block measures no TTFT')

  const perTask = parseAaModelPage(
    pageHtml({
      include: { latency: false, endToEnd: false },
      blocks: { cost: dataset('Time per Intelligence Index Task', { inputTime: 3.5, reasoningTime: 9 }) },
    }),
  )
  assert.equal(ttftOf(perTask), null)
})

test('an explicit answer-token field wins over the inputTime/reasoningTime pair', () => {
  const page = parseAaModelPage(
    pageHtml({ include: { endToEnd: false }, blocks: { latency: latencyBlock({ medianTimeToFirstAnswerTokenSeconds: 0.31, inputTime: 0.42, reasoningTime: 12.5 }) } }),
  )
  assert.equal(ttftOf(page), 0.31)
})

test('a latency block carrying only thinking time reports no TTFT', () => {
  const page = parseAaModelPage(pageHtml({ include: { endToEnd: false }, blocks: { latency: latencyBlock({ reasoningTime: 12.5 }) } }))
  // Thinking time is not a first token: this is "not measured", never 0 and
  // never the thinking time itself. The field deliberately carries ONLY the
  // TTFT as a number — folding reasoning in would report the 38.9s answer-token
  // latency as if it were a 2.9s TTFT.
  assert.equal(ttftOf(page), null)
  assert.equal(reasoningOf(page), null, 'the thinking time is not smuggled into the TTFT field')
})

test('the latency field carries the TTFT as a plain number', () => {
  // The documented contract is `timeToFirstAnswerTokenSeconds: number|null`.
  // A value that varied between a number and an object would defeat every
  // consumer's null check — including `lib/aa/client.js`, which coerces this
  // field into the lookup result, and `hasMeasurements`, which decides whether a
  // page answered the question at all.
  const value = parseAaModelPage(STANDARD_PAGE).timeToFirstAnswerTokenSeconds
  assert.equal(typeof value, 'number', 'the latency field is a number, never a wrapper object')
  assert.equal(value, 0.42)

  const unmeasured = without('latency').timeToFirstAnswerTokenSeconds
  assert.equal(unmeasured, null, 'an unmeasured latency is null, not an object of nulls')
})

test('the intelligence score ignores a bare `score` on a non-intelligence dataset', () => {
  const other = dataset('Economic Index', { score: 7 })
  const page = parseAaModelPage(pageHtml({ include: { score: false }, blocks: { endToEnd: other } }))
  assert.equal(page.scores, null, 'a `score` from another index is not the intelligence score')
  assert.equal(page.scoreName, SCORE_NAME)

  // A bare `score` on the index block itself is the documented fallback.
  const fallback = parseAaModelPage(pageHtml({ include: { endToEnd: false }, blocks: { score: scoreBlock({ score: 39.5 }) } }))
  assert.equal(fallback.scores, 39.5)
  assert.equal(fallback.scoreName, SCORE_NAME)
})

test('an exact index field outranks a bare score inside the same block', () => {
  const page = parseAaModelPage(pageHtml({ blocks: { score: scoreBlock({ score: 12, intelligenceIndex: 41.25 }) } }))
  assert.equal(page.scores, 41.25)
})

test('per-task cost fields are never read as per-1M-token prices', () => {
  // `input` / `cacheHit` on AA's cost datasets are USD per Intelligence Index
  // task; reading them as prices understates every price by ~100x.
  const page = parseAaModelPage(pageHtml({ include: { price: false } }))
  assert.deepEqual(page.pricePer1M, { input: null, output: null, cacheRead: null })
})

test('the scoreVersion is read from the block prose', () => {
  assert.equal(parseAaModelPage(STANDARD_PAGE).scoreVersion, 'v9.9')
  const unversioned = parseAaModelPage(pageHtml({ blocks: { score: dataset(SCORE_NAME, { intelligenceIndex: 41.25 }) } }))
  assert.equal(unversioned.scoreVersion, null, 'no version stated is null, not a guess')
})

/* ------------------------------------------------------------------ */
/* degraded documents                                                  */
/* ------------------------------------------------------------------ */

test('a 404-shaped HTML shell yields null rather than throwing', () => {
  const shells = [
    '<!doctype html><html><head><title>404</title></head><body><h1>404 - Not Found</h1></body></html>',
    '<html><body>Just a moment…</body></html>',
    // A non-Dataset JSON-LD block is not a measurement either.
    `<html><head><title>Artificial Analysis</title></head><body>${ld(JSON.stringify({ '@type': 'WebSite', name: 'Artificial Analysis' }))}</body></html>`,
    // A Dataset block with no page identity to match entries against.
    `<html><body>${ld(JSON.stringify(dataset('Output Speed', { medianOutputTokensPerSecond: 88.5 })))}</body></html>`,
    // A Dataset with an empty data array.
    `<html><head><title>x</title></head><body>${ld(JSON.stringify({ '@type': 'Dataset', name: 'Output Speed', data: [] }))}</body></html>`,
  ]
  for (const shell of shells) {
    assert.equal(parseAaModelPage(shell), null, shell.slice(0, 60))
  }
})

test('a page whose JSON-LD is syntactically broken yields null', () => {
  const broken = pageHtml({
    blocks: {
      score: '{"@type":"Dataset","name":"Artificial Analysis Intelligence Index","data":[{"intelligenceIndex":41.25,',
      speed: 'not json at all',
      price: '{"@type":"Dataset","data":[]',
    },
    include: { latency: false, endToEnd: false, cost: false, context: false, faq: false },
  })
  assert.equal(parseAaModelPage(broken), null)
})

test('one malformed block costs one metric, not the whole page', () => {
  const page = parseAaModelPage(pageHtml({ blocks: { latency: '{"broken":' } }))
  assert.notEqual(page, null)
  assert.equal(page.scores, 41.25, 'the readable blocks still answer')
  assert.equal(ttftOf(page), null)
})

test('a page whose datasets never mention this model keeps its identity and drops every metric', () => {
  const foreign = dataset('Output Speed', { medianOutputTokensPerSecond: 88.5 })
  foreign.data[0] = { label: 'Another-Model', detailsUrl: '/models/another-model', medianOutputTokensPerSecond: 88.5 }
  const page = parseAaModelPage(pageHtml({ include: {}, blocks: { speed: foreign, score: foreign, price: foreign, context: foreign, latency: foreign, endToEnd: foreign, cost: foreign, faq: false } }))
  assert.notEqual(page, null)
  assert.equal(page.name, NAME)
  assert.equal(page.scores, null)
  assert.equal(page.tokensPerSecond, null)
  assert.equal(ttftOf(page), null)
  assert.equal(page.contextWindow, null)
  assert.deepEqual(page.pricePer1M, { input: null, output: null, cacheRead: null })
})

/* ------------------------------------------------------------------ */
/* absent vs genuine zero                                              */
/* ------------------------------------------------------------------ */

/** Everything the standard page measures, with one block omitted. */
function without(key) {
  return parseAaModelPage(pageHtml({ include: { [key]: false } }))
}

test('an omitted score is null, never 0', () => {
  const page = without('score')
  assert.equal(page.scores, null)
  assert.equal(page.scoreName, SCORE_NAME, 'the metric name is still reported')
})

test('an omitted speed is null, never 0', () => {
  assert.equal(without('speed').tokensPerSecond, null)
})

test('an omitted latency is null, never 0', () => {
  assert.equal(ttftOf(without('latency')), null)
})

test('an omitted context window is null, never 0', () => {
  const page = parseAaModelPage(pageHtml({ include: { context: false, faq: false } }))
  assert.equal(page.contextWindow, null)
})

test('an omitted pricing block leaves all three rates null, never 0', () => {
  const page = without('price')
  assert.deepEqual(page.pricePer1M, { input: null, output: null, cacheRead: null })
  for (const rate of Object.values(page.pricePer1M)) assert.equal(rate, null)
})

test('a price row with an unreadable value is null while its neighbours survive', () => {
  const page = parseAaModelPage(
    pageHtml({
      include: { cost: false },
      blocks: {
        price: priceBlock([
          { name: 'Input Price', value: 'n/a' },
          { name: 'Output Price', value: null },
          { name: 'Cache Hit Price', value: 0.05 },
        ]),
      },
    }),
  )
  assert.deepEqual(page.pricePer1M, { input: null, output: null, cacheRead: 0.05 })
})

test('a genuine 0 survives as 0 in every price field', () => {
  // A token-plan route really costs nothing per token; `??=` and `toNumber`
  // must not confuse that with "absent".
  const page = parseAaModelPage(
    pageHtml({
      include: { cost: false },
      blocks: {
        price: priceBlock([
          { name: 'Input Price', value: 0 },
          { name: 'Output Price', value: 0 },
          { name: 'Cache Hit Price', value: 0 },
        ]),
      },
    }),
  )
  assert.deepEqual(page.pricePer1M, { input: 0, output: 0, cacheRead: 0 })
  assert.ok(Object.is(page.pricePer1M.input, 0))

  const flat = parseAaModelPage(
    pageHtml({
      include: { cost: false },
      blocks: { price: dataset('Pricing: USD per 1M tokens', { inputPrice: 0, outputPrice: 0.6 }) },
    }),
  )
  assert.deepEqual(flat.pricePer1M, { input: 0, output: 0.6, cacheRead: null })
})

test('a genuine 0 score survives as 0', () => {
  const page = parseAaModelPage(pageHtml({ blocks: { score: scoreBlock({ intelligenceIndex: 0 }) } }))
  assert.equal(page.scores, 0)
  assert.ok(Object.is(page.scores, 0))
})

test('a genuine 0 speed survives as 0', () => {
  assert.equal(parseAaModelPage(pageHtml({ blocks: { speed: speedBlock({ medianOutputTokensPerSecond: 0 }) } })).tokensPerSecond, 0)
})

test('every absent measurement on a page with no measurements is null rather than 0', () => {
  // One Dataset block stays, so the page still has an identity; every number it
  // could have reported is absent.
  const page = parseAaModelPage(
    pageHtml({ include: { score: false, speed: false, latency: false, endToEnd: false, price: false, context: false, faq: false } }),
  )
  assert.notEqual(page, null)
  const numbers = [page.scores, page.tokensPerSecond, ttftOf(page), page.contextWindow]
  for (const value of numbers) assert.equal(value, null)
  assert.deepEqual(page.pricePer1M, { input: null, output: null, cacheRead: null })
})

/* ------------------------------------------------------------------ */
/* parseTokenCount                                                     */
/* ------------------------------------------------------------------ */

test('parseTokenCount reads numbers and every display form AA uses', () => {
  assert.equal(parseTokenCount(131072), 131072)
  assert.equal(parseTokenCount('128K'), 128000)
  assert.equal(parseTokenCount('1M'), 1000000)
  assert.equal(parseTokenCount('1,000,000'), 1000000)
  assert.equal(parseTokenCount('260k tokens'), 260000)
  assert.equal(parseTokenCount('1.0M'), 1000000)
  assert.equal(parseTokenCount('2B'), 2000000000)
  assert.equal(parseTokenCount('131072'), 131072)
  assert.equal(parseTokenCount(0), 0, 'a genuine zero count is 0, not null')
  assert.equal(parseTokenCount(1048576.4), 1048576, 'counts are whole tokens')
})

test('parseTokenCount returns null for anything it cannot read', () => {
  for (const value of ['', '   ', 'garbage', 'K', 'M', 'many tokens', null, undefined, true, {}, [], NaN, Infinity, -1, -5]) {
    assert.equal(parseTokenCount(value), null, String(value))
  }
})

/* ------------------------------------------------------------------ */
/* parseAaFreeIndex                                                    */
/* ------------------------------------------------------------------ */

/** The documented Free-index envelope, with invented numbers. */
const FREE_ENVELOPE = {
  tier: 'free',
  intelligence_index_version: 'v9.9',
  generated_at: '2025-06-01T00:00:00Z',
  pagination: { page: 1, page_size: 25, total_pages: 3, has_more: true },
  data: [
    {
      id: 'tm-a',
      name: `  ${NAME}  `,
      slug: ` ${SLUG} `,
      release_date: '2025-05-01',
      model_creator: { id: 'fx', name: 'Fixture Labs', slug: 'fixture-labs' },
      evaluations: { artificial_analysis_intelligence_index: 41.25 },
      pricing: { price_1m_input_tokens: 0.15, price_1m_output_tokens: 0.6, price_1m_cache_hit_tokens: 0.05 },
      performance: { median_output_tokens_per_second: 88.5, median_time_to_first_answer_token_seconds: 0.42 },
      context_window_tokens: 131072,
    },
  ],
}

test('parseAaFreeIndex normalizes the documented envelope', () => {
  const entries = parseAaFreeIndex(FREE_ENVELOPE)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    id: 'tm-a',
    name: NAME,
    slug: SLUG,
    modelCreator: 'Fixture Labs',
    scores: 41.25,
    scoreName: SCORE_NAME,
    tokensPerSecond: 88.5,
    timeToFirstAnswerTokenSeconds: 0.42,
    pricePer1M: { input: 0.15, output: 0.6, cacheRead: 0.05 },
    contextWindow: 131072,
    generatedAt: '2025-06-01T00:00:00Z',
  })
  // The index entry uses the same score name and the same price triple shape as
  // a parsed page, so the renderer has one shape to handle.
  const page = parseAaModelPage(STANDARD_PAGE)
  assert.equal(entries[0].scoreName, page.scoreName)
  assert.deepEqual(Object.keys(entries[0].pricePer1M), Object.keys(page.pricePer1M))
})

test('parseAaFreeIndex tolerates the alternate key spellings it supports', () => {
  const entries = parseAaFreeIndex({
    intelligenceIndexVersion: 'v9.9',
    updatedAt: '2025-06-02T00:00:00Z',
    models: [
      {
        id: 7,
        name: NAME,
        slug: SLUG,
        // camelCase direct fields, a plain-string creator and a display count.
        modelCreator: 'Fixture Labs',
        intelligenceIndex: 41.25,
        medianOutputTokensPerSecond: 88.5,
        timeToFirstAnswerTokenSeconds: 0.42,
        inputPrice: 0.15,
        outputPrice: 0.6,
        cacheReadPrice: 0.05,
        context_window: '260K',
      },
    ],
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 7)
  assert.equal(entries[0].scores, 41.25)
  assert.equal(entries[0].tokensPerSecond, 88.5)
  assert.equal(entries[0].timeToFirstAnswerTokenSeconds, 0.42)
  assert.deepEqual(entries[0].pricePer1M, { input: 0.15, output: 0.6, cacheRead: 0.05 })
  assert.equal(entries[0].contextWindow, 260000)
  assert.equal(entries[0].modelCreator, 'Fixture Labs')
  assert.equal(entries[0].generatedAt, '2025-06-02T00:00:00Z')
})

test('parseAaFreeIndex reads a nested context_window object and a snake_case creator', () => {
  const entries = parseAaFreeIndex({
    results: [{ name: NAME, model_creator: 'Fixture Labs', context_window: { size: '200K' } }],
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].modelCreator, 'Fixture Labs')
  assert.equal(entries[0].contextWindow, 200000)
  assert.equal(entries[0].scores, null, 'unmeasured stays null')
  assert.equal(entries[0].pricePer1M, null, 'no price fields at all is null, not a zeroed triple')
})

test('parseAaFreeIndex accepts a bare entry array and the probed envelope keys', () => {
  for (const envelope of [
    [{ name: NAME, slug: SLUG, intelligenceIndex: 41.25 }],
    { data: [{ name: NAME, slug: SLUG, intelligenceIndex: 41.25 }] },
    { models: [{ name: NAME, slug: SLUG, intelligenceIndex: 41.25 }] },
    { results: [{ name: NAME, slug: SLUG, intelligenceIndex: 41.25 }] },
    { items: [{ name: NAME, slug: SLUG, intelligenceIndex: 41.25 }] },
  ]) {
    const entries = parseAaFreeIndex(envelope)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].scores, 41.25)
    assert.equal(entries[0].name, NAME)
  }
})

test('parseAaFreeIndex keeps a documented zero and rejects an unreadable number', () => {
  const entries = parseAaFreeIndex({
    data: [
      {
        name: NAME,
        slug: SLUG,
        evaluations: { artificial_analysis_intelligence_index: 0 },
        pricing: { price_1m_input_tokens: 0, price_1m_output_tokens: 0, price_1m_cache_hit_tokens: 0 },
        performance: { median_output_tokens_per_second: 'n/a' },
      },
    ],
  })
  assert.equal(entries[0].scores, 0)
  assert.deepEqual(entries[0].pricePer1M, { input: 0, output: 0, cacheRead: 0 })
  assert.equal(entries[0].tokensPerSecond, null)
})

test('parseAaFreeIndex drops unusable rows and never invents a name', () => {
  const entries = parseAaFreeIndex({ data: [null, 42, 'x', [], { id: 'only-an-id' }, { name: '   ' }] })
  assert.equal(entries.length, 2, 'the two records survive')
  assert.deepEqual(entries[0], {
    id: 'only-an-id',
    name: null,
    slug: null,
    modelCreator: null,
    scores: null,
    scoreName: SCORE_NAME,
    tokensPerSecond: null,
    timeToFirstAnswerTokenSeconds: null,
    pricePer1M: null,
    contextWindow: null,
    generatedAt: null,
  })
  assert.equal(entries[1].name, null, 'whitespace is not a name')
})

test('parseAaFreeIndex returns [] for garbage', () => {
  for (const value of [null, undefined, 42, '', '<html>', '{}', '[]', {}, { data: [] }, [], { data: 'nope' }, { pagination: {} }, true]) {
    assert.deepEqual(parseAaFreeIndex(value), [], JSON.stringify(value) ?? String(value))
  }
})

/* ------------------------------------------------------------------ */
/* totality                                                            */
/* ------------------------------------------------------------------ */

/** Inputs every parser must survive. */
function hostileInputs() {
  /** @type {Record<string, unknown>} */
  const deep = {}
  let cursor = deep
  for (let depth = 0; depth < 40; depth += 1) {
    cursor.child = { depth, data: [null, { nested: { deeper: [1, 2, 3] } }] }
    cursor = cursor.child
  }
  return {
    null: null,
    undefined,
    number: 42,
    empty: '',
    html: '<html>',
    emptyObject: '{}',
    emptyArray: '[]',
    jsonArray: [1, 2, 3],
    jsonArrayString: '[{"name":"x"}]',
    nestedArray: [[[[[1]]]]],
    deeplyNested: deep,
    deeplyNestedWithRows: { ...deep, data: [deep, deep] },
  }
}

test('parseAaModelPage never throws and answers null for every unusable document', () => {
  for (const [label, value] of Object.entries(hostileInputs())) {
    assert.doesNotThrow(() => parseAaModelPage(value), label)
    assert.equal(parseAaModelPage(value), null, label)
  }
})

test('parseAaFreeIndex never throws and answers [] for every unusable document', () => {
  for (const [label, value] of Object.entries(hostileInputs())) {
    assert.doesNotThrow(() => parseAaFreeIndex(value), label)
    assert.ok(Array.isArray(parseAaFreeIndex(value)), label)
  }
})

test('parseTokenCount never throws', () => {
  for (const [label, value] of Object.entries(hostileInputs())) {
    assert.doesNotThrow(() => parseTokenCount(value), label)
    // A raw finite number is a valid count; everything else is null.
    const expected = typeof value === 'number' && value >= 0 ? Math.round(value) : null
    assert.equal(parseTokenCount(value), expected, label)
  }
})

test('a truncated or oversized document is still answered, not thrown at', () => {
  const page = STANDARD_PAGE
  for (const slice of [page.slice(0, 200), page.slice(0, page.length / 2), page, `${page}${page}`]) {
    assert.doesNotThrow(() => parseAaModelPage(slice))
  }
  assert.equal(parseAaModelPage(page.slice(0, 200)), null, 'a header alone is not a profile')
  assert.equal(parseAaModelPage(`${page}${page}`).scores, 41.25, 'a duplicated page still parses')
})

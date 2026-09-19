/* Profile merging and rendering.
 *
 * The plugin's whole value proposition is that every number it prints is
 * attributed to an authority it actually read. These tests pin the two ways
 * that promise can break:
 *
 *   - a lower layer winning a field a higher layer already answered, and
 *   - a missing measurement being rendered as a real `0`.
 *
 * The second failure is the dangerous one in this domain: on a subscription
 * route the catalogue rate really is 0, and printing `$0.00` would tell the
 * model that delegation is free per token, which is false and would change
 * routing decisions. Hence `allZeroCost` renders as a subscription route and
 * nothing ever renders "free".
 *
 * Offline; `lib/catalog.js` imports only `lib/model-id.js`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatProfileLines,
  mergeProfile,
  parseProfilesKey,
  resolveConfiguredProfile,
} from '../lib/catalog.js'

/** Join the rendered line block for easy substring assertions. */
function render(profile, options) {
  return formatProfileLines(profile, options).join('\n')
}

/* ------------------------------------------------------------------ */
/* explicit user override                                              */
/* ------------------------------------------------------------------ */

test('profiles keys parse only in route shape', () => {
  assert.deepEqual(parseProfilesKey('qwen-token-plan-cn/qwen3.8-flash'), {
    provider: 'qwen-token-plan-cn',
    model: 'qwen3.8-flash',
  })
  assert.deepEqual(parseProfilesKey('a/b/c'), { provider: 'a', model: 'b/c' }, 'the model id may contain a slash')
  assert.equal(parseProfilesKey('qwen3.8-flash'), null, 'a bare model id is not a route key')
  assert.equal(parseProfilesKey('/m'), null)
  assert.equal(parseProfilesKey('p/'), null)
  assert.equal(parseProfilesKey(''), null)
  assert.equal(parseProfilesKey(42), null)
})

test('a configured profile is found by exact route key', () => {
  const config = { profiles: { 'p/m': { score: 12.5, note: 'pinned' } } }
  const found = resolveConfiguredProfile(config, 'p', 'm')
  assert.ok(found)
  assert.equal(found.resolve, true)
  assert.deepEqual(found.override, { score: 12.5, note: 'pinned' })
})

test('a configured profile is found by a bare normalized model key', () => {
  const config = { profiles: { 'qwen3-8-flash': { score: 39.9 } } }
  const found = resolveConfiguredProfile(config, 'qwen-token-plan-cn', 'qwen3.8-flash')
  assert.ok(found, 'qwen3.8-flash normalizes onto the qwen3-8-flash key')
  assert.equal(found.override.score, 39.9)
})

test('an alias slug is NOT a profile key: that mapping belongs to the AA lookup', () => {
  // `data/aliases.json` exists to translate a local id into an Artificial
  // Analysis slug. It must not silently capture a user override written for a
  // different model id, so a key that only an alias could reach does not match.
  const config = { profiles: { 'qwen3-8-flash-next': { score: 39.9 } } }
  assert.equal(resolveConfiguredProfile(config, 'qwen-token-plan-cn', 'qwen3.8-flash'), null)
  // The explicit way to attach one is `alias`, which is carried into the render.
  const explicit = resolveConfiguredProfile({ profiles: { 'qwen3.8-flash': { alias: 'qwen3-8-flash-next' } } }, 'p', 'qwen3.8-flash')
  assert.equal(explicit.override.alias, 'qwen3-8-flash-next')
})

test('a route-shaped key never leaks onto a different provider', () => {
  const config = { profiles: { 'other-provider/qwen3.8-flash': { score: 1 } } }
  assert.equal(resolveConfiguredProfile(config, 'qwen-token-plan-cn', 'qwen3.8-flash'), null)
})

test('resolve:false is carried through, both per entry and globally', () => {
  assert.equal(resolveConfiguredProfile({ profiles: { 'p/m': { resolve: false, score: 1 } } }, 'p', 'm').resolve, false)
  assert.equal(resolveConfiguredProfile({ resolve: false, profiles: { 'p/m': { score: 1 } } }, 'p', 'm').resolve, false)
  assert.equal(resolveConfiguredProfile({ profiles: { 'p/m': { score: 1 } } }, 'p', 'm').resolve, true)
})

test('a resolved override is a detached copy', () => {
  const entry = { score: 1, nested: { a: 1 } }
  const found = resolveConfiguredProfile({ profiles: { 'p/m': entry } }, 'p', 'm')
  assert.notEqual(found.override, entry)
  found.override.score = 99
  assert.equal(entry.score, 1)
})

test('resolveConfiguredProfile is total', () => {
  assert.equal(resolveConfiguredProfile(undefined, 'p', 'm'), null)
  assert.equal(resolveConfiguredProfile({}, 'p', 'm'), null)
  assert.equal(resolveConfiguredProfile({ profiles: { 'p/m': 'not-a-record' } }, 'p', 'm'), null)
  assert.equal(resolveConfiguredProfile({ profiles: null }, 'p', 'm'), null)
  assert.equal(resolveConfiguredProfile({ profiles: { 'p/m': { score: 1 } } }, '', 'm'), null)
  assert.equal(resolveConfiguredProfile({ profiles: { 'p/m': { score: 1 } } }, 'p', ''), null)
  assert.equal(resolveConfiguredProfile({ profiles: new Map([['p/m', { score: 2 }]]) }, 'p', 'm').override.score, 2)
})

/* ------------------------------------------------------------------ */
/* layer precedence                                                    */
/* ------------------------------------------------------------------ */

const AA_LAYER = {
  rawName: 'Qwen3.8-Flash-Next',
  slug: 'qwen3-8-flash-next',
  scores: 39.914,
  scoreName: 'Artificial Analysis Intelligence Index',
  scoreVersion: 'v3.0',
  rank: 11,
  ofCount: 60,
  tokensPerSecond: 55.47,
  timeToFirstAnswerTokenSeconds: 2.89,
  pricePer1M: { input: 0.15, output: 0.47, cacheRead: 0.016 },
  contextWindow: 1000000,
  sourceOrigin: 'aa-page',
  generatedAt: '2026-09-05T11:58:56.761Z',
  fetchedAt: '2026-09-19T10:00:00.000Z',
}

test('every field group falls back to the layer that has it', () => {
  const profile = mergeProfile({
    provider: 'qwen-token-plan-cn',
    model: 'qwen3.8-flash',
    runtime: { name: 'Qwen3.8 Flash', contextWindow: 1000000, defaultMaxTokens: 65536, reasoning: { efforts: [{ id: 'xhigh' }] } },
    piAi: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 65536 },
    aa: AA_LAYER,
  })
  assert.equal(profile.scores, 39.914)
  assert.equal(profile.rank, 11)
  assert.equal(profile.ofCount, 60)
  assert.equal(profile.tokensPerSecond, 55.47)
  assert.equal(profile.contextWindow, 1000000)
  assert.equal(profile.maxTokens, 65536)
  assert.equal(profile.sources.score, 'aa')
  assert.equal(profile.sources.price, 'pi-ai')
  assert.equal(profile.aaReason, null)
})

test('a user override beats both pi-ai and AA', () => {
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    configured: { score: 1, inputPer1M: 9, outputPer1M: 10, contextWindow: 128000, tokensPerSecond: 1 },
    piAi: { cost: { input: 0.5, output: 1.5, cacheRead: 0.05 }, contextWindow: 64000 },
    aa: AA_LAYER,
  })
  assert.equal(profile.scores, 1, 'configured score wins')
  assert.equal(profile.sources.score, 'config')
  assert.deepEqual(profile.pricePer1M, { input: 9, output: 10, cacheRead: null })
  assert.equal(profile.sources.price, 'config')
  assert.equal(profile.tokensPerSecond, 1)
  assert.equal(profile.sources.speed, 'config')
})

test('a configured score beats AA even when AA is present', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', configured: { score: 5 }, aa: AA_LAYER })
  assert.equal(profile.scores, 5)
  assert.equal(profile.sources.score, 'config')
  assert.equal(profile.tokensPerSecond, 55.47, 'AA still owns the fields the override did not set')
})

test('a runtime read is never presented as an AA reading', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', runtime: { contextWindow: 200000 } })
  assert.equal(profile.contextWindow, 200000)
  assert.equal(profile.contextOrigin, 'runtime')
  assert.equal(profile.sources.score, null)
  assert.equal(profile.sources.price, null)
})

test('a failed AA lookup is reported as a reason, never as data', () => {
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    runtime: { contextWindow: 128000 },
    aa: { ok: false, reason: 'not-on-aa' },
  })
  assert.equal(profile.scores, null)
  assert.equal(profile.tokensPerSecond, null)
  assert.equal(profile.aaReason, 'not-on-aa')
  assert.equal(profile.sourceUrl, null)
  assert.equal(profile.sources.score, null)
})

/* ------------------------------------------------------------------ */
/* the zero-price trap                                                 */
/* ------------------------------------------------------------------ */

test('a genuine all-zero catalogue rate renders as a subscription route, never as free', () => {
  const profile = mergeProfile({
    provider: 'qwen-token-plan-cn',
    model: 'qwen3.8-flash',
    piAi: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  })
  assert.equal(profile.allZeroCost, true)
  const single = render(profile, { isSingle: true })
  assert.match(single, /subscription route/)
  assert.ok(!/\$0\.00/.test(single), 'a subscription route must never print $0.00')
  assert.ok(!/\bfree\b/i.test(single), 'a subscription route must never print "free"')
  // The list layout must be equally honest.
  const list = render(profile, { isSingle: false })
  assert.match(list, /subscription route/)
  assert.ok(!/\$0\.00/.test(list))
})

test('a partially measured zero is NOT a subscription route', () => {
  // Only a route that is zero on EVERY measured rate is a subscription route;
  // a free input with a priced output is an ordinary priced route.
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    piAi: { cost: { input: 0, output: 1.25, cacheRead: 0, cacheWrite: 0 } },
  })
  assert.equal(profile.allZeroCost, false)
  const text = render(profile, { isSingle: true })
  assert.match(text, /\$0\.00/)
  assert.match(text, /\$1\.25/)
  assert.ok(!/subscription route/.test(text))
})

test('a null AA measurement is omitted, never printed as 0', () => {
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    aa: {
      ...AA_LAYER,
      pricePer1M: { input: null, output: null, cacheRead: null },
      tokensPerSecond: null,
      timeToFirstAnswerTokenSeconds: null,
      contextWindow: null,
    },
  })
  assert.equal(profile.tokensPerSecond, null)
  assert.equal(profile.contextWindow, null)
  const text = render(profile, { isSingle: true })
  assert.ok(!/speed 0/.test(text), 'an unmeasured speed must not render as 0')
  assert.ok(!/context 0/.test(text), 'an unmeasured context must not render as 0')
  assert.ok(!/\$0\.00/.test(text), 'an unmeasured price must not render as $0.00')
  // Absence is stated instead of implied, because "no number" would otherwise
  // read as "nothing wrong here".
  assert.match(text, /speed not measured/)
  assert.match(text, /score 39\.9/, 'the measured score is still shown')
})

test('AA latency reaches the renderer through the merged field name', () => {
  // The AA parser names this metric `timeToFirstAnswerTokenSeconds`; the client
  // maps it onto the same field of the catalogue layer, and the renderer reads
  // it from there. A rename on either side would silently drop the metric, so
  // the full path is asserted rather than just the merged value.
  const aa = { ...AA_LAYER, timeToFirstAnswerTokenSeconds: 2.89 }
  const profile = mergeProfile({ provider: 'p', model: 'm', aa })
  assert.equal(profile.timeToFirstAnswerTokenSeconds, 2.89)
  assert.match(render(profile, { isSingle: true }), /latency to first answer token 2\.89s/)
  // The list layout spells the label out too: the value is AA's "Time To First
  // Answer Token", so a bare "latency" would invite the wrong comparison.
  assert.match(render(profile, { isSingle: false }), /latency to first answer token 2\.89s/)
})

test('a configured latency override is read from either spelling', () => {
  const long = mergeProfile({ provider: 'p', model: 'm', configured: { timeToFirstAnswerTokenSeconds: 1.5 } })
  assert.equal(long.timeToFirstAnswerTokenSeconds, 1.5)
  const short = mergeProfile({ provider: 'p', model: 'm', configured: { ttft: 3 } })
  assert.equal(short.timeToFirstAnswerTokenSeconds, 3)
})

test('merging nothing at all yields a null-field profile that renders the identity line', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm' })
  assert.equal(profile.scores, null)
  assert.equal(profile.pricePer1M.input, null)
  assert.equal(profile.allZeroCost, false)
  const lines = formatProfileLines(profile, { isSingle: true })
  assert.equal(lines[0], 'p/m', 'the identity line is always present')
  assert.match(lines.join('\n'), /Artificial Analysis/)
})

/* ------------------------------------------------------------------ */
/* reasoning and runtime pass-throughs                                 */
/* ------------------------------------------------------------------ */

test('runtime reasoning efforts survive the merge', () => {
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    runtime: { reasoning: { efforts: [{ id: 'low' }, { id: 'xhigh' }], defaultEffort: 'xhigh' } },
  })
  const text = render(profile, { isSingle: true })
  assert.match(text, /reasoning low, xhigh \(default xhigh\)/)
})

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

test('the attribution line is mandatory and names the source site', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', aa: AA_LAYER })
  for (const isSingle of [true, false]) {
    const lines = formatProfileLines(profile, { isSingle })
    const attribution = lines.find((line) => line.startsWith('Source:'))
    assert.ok(attribution, `attribution missing from isSingle=${isSingle}`)
    assert.equal(attribution, 'Source: Artificial Analysis (artificialanalysis.ai)')
  }
})

test('the attribution can be suppressed for embedding, but only explicitly', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', aa: AA_LAYER })
  const lines = formatProfileLines(profile, { isSingle: true, includeAttribution: false })
  assert.ok(!lines.some((line) => line.startsWith('Source:')))
  // Default (no option object at all) keeps it.
  assert.ok(formatProfileLines(profile).some((line) => line.startsWith('Source:')))
})

test('the single layout is a superset of the list layout', () => {
  const profile = mergeProfile({
    provider: 'p',
    model: 'm',
    aa: AA_LAYER,
    runtime: { reasoning: { efforts: [{ id: 'low' }] } },
    piAi: { maxTokens: 65536 },
  })
  const single = formatProfileLines(profile, { isSingle: true })
  const list = formatProfileLines(profile, { isSingle: false })
  assert.ok(single.length > list.length, 'the dossier carries strictly more lines')
  assert.match(single.join('\n'), /max output 65,536/)
  assert.match(single.join('\n'), /reasoning low/)
  assert.ok(!/max output/.test(list.join('\n')), 'the compact layout stays two lines per model')
})

test('an AA failure is rendered as a human reason with the budget when known', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', aa: { ok: false, reason: 'timeout' } })
  const text = render(profile, { isSingle: true, aaTimeoutMs: 8000 })
  assert.match(text, /not available: lookup timed out after 8000ms/)
  assert.match(text, /Artificial Analysis/)
})

test('every documented AA failure reason renders readable text', () => {
  for (const reason of ['timeout', 'not-on-aa', 'key-invalid', 'tier', 'rate-limited', 'http', 'unavailable', 'disabled', 'offline']) {
    const profile = mergeProfile({ provider: 'p', model: 'm', aa: { ok: false, reason } })
    const text = render(profile, { isSingle: true })
    assert.match(text, /not available: /, `reason ${reason} must render`)
    assert.ok(!text.includes('undefined'), `reason ${reason} must not leak undefined`)
  }
})

test('offline mode is never described as a timeout', () => {
  // `config.timeoutMs: 0` switches the network off; it is a configuration, not a
  // slow network, so the model-facing line must send the operator to their
  // snapshot rather than to a timeout knob they never exceeded. A zero budget
  // passing through the timeout wording is the exact symptom this guards.
  const profile = mergeProfile({ provider: 'p', model: 'm', aa: { ok: false, reason: 'offline' } })
  const text = render(profile, { isSingle: true })
  assert.match(text, /not in the local snapshot/, 'offline names the local snapshot as the missing source')
  assert.doesNotMatch(text, /timed out|no answer within/, 'a zero budget must never read as a timeout')
  assert.doesNotMatch(text, /after 0ms|after 1ms/, 'no fabricated millisecond figure')
})

test('formatProfileLines is total', () => {
  // A profile with no route identity still renders a labelled line rather than
  // throwing or emitting an empty block: the caller appends whatever it gets,
  // so "nothing" must be an explicit, readable string.
  assert.deepEqual(formatProfileLines(null), ['unknown route', 'Source: Artificial Analysis (artificialanalysis.ai)'])
  assert.deepEqual(formatProfileLines(undefined, { isSingle: true }), ['unknown route', 'Source: Artificial Analysis (artificialanalysis.ai)'])
  assert.deepEqual(formatProfileLines('nope', { isSingle: true, includeAttribution: false }), ['unknown route'])
})

test('the renderer never prints a bare zero for an unknown token count', () => {
  const profile = mergeProfile({ provider: 'p', model: 'm', runtime: { defaultMaxTokens: 0 } })
  const text = render(profile, { isSingle: true })
  // A real 0 is still a measured value and may be printed; what must not happen
  // is a missing value turning into 0. Here the value came from the runtime.
  assert.match(text, /max output 0/)
})

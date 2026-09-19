/* Parsing of the native `list_subagent_models` result text.
 *
 * There is no harness and no network here: `lib/native-listing.js` is pure, so
 * this file is the specification of the exact native wire format. Three things
 * are load-bearing for the plugin's honesty and are asserted explicitly:
 *
 *   1. the separator is an em dash (U+2014), space-padded — a parser that
 *      accepts a hyphen would mis-split `deepseek-v4-flash` and invent routes;
 *   2. unrecognized text yields `[]` / `null` rather than a guess, because the
 *      handler must then leave the model's tool result completely untouched;
 *   3. the reasoning block is preserved byte-for-byte.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_TOOL_NAME,
  detectMode,
  extractText,
  parseModelDetail,
  parseModelList,
  parseProviderList,
} from '../lib/native-listing.js'

/** Prefix marker so a byte-for-byte failure is readable. */
const EM_DASH = '\u2014'

/* ------------------------------------------------------------------ */
/* detectMode — which native shape the model asked for                 */
/* ------------------------------------------------------------------ */

test('detectMode maps each argument shape onto its native output shape', () => {
  assert.equal(detectMode(undefined), 'providers', 'no arguments lists providers')
  assert.equal(detectMode(null), 'providers')
  assert.equal(detectMode({}), 'providers')
  assert.equal(detectMode({ provider: 'qwen-token-plan-cn' }), 'models')
  assert.equal(detectMode({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }), 'model')
})

test('detectMode reads the raw JSON string form of exec.arguments', () => {
  assert.equal(detectMode('{"provider":"p"}'), 'models')
  assert.equal(detectMode('{"provider":"p","model":"m"}'), 'model')
  assert.equal(detectMode('{}'), 'providers')
})

test('detectMode refuses to guess on unusable arguments', () => {
  assert.equal(detectMode('not json'), 'unknown')
  assert.equal(detectMode('[1,2,3]'), 'unknown')
  assert.equal(detectMode('42'), 'unknown')
  assert.equal(detectMode({ provider: '' }), 'unknown', 'empty provider is not a provider')
  assert.equal(detectMode({ provider: 'p', model: '' }), 'unknown', 'empty model is not a model')
  assert.equal(detectMode({ provider: 7 }), 'unknown')
  assert.equal(detectMode({ model: 'm' }), 'unknown', 'model without provider is ambiguous')
})

/* ------------------------------------------------------------------ */
/* provider list                                                       */
/* ------------------------------------------------------------------ */

test('parseProviderList reads the native provider lines', () => {
  const text = 'qwen-token-plan-cn \u2014 qwen-token-plan-cn\ndeepseek-official \u2014 DeepSeek'
  assert.deepEqual(parseProviderList(text), [
    { provider: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' },
    { provider: 'deepseek-official', name: 'DeepSeek' },
  ])
})

test('parseProviderList rejects anything that is not a provider list', () => {
  assert.deepEqual(parseProviderList('(no LLM providers)'), [], 'the literal empty result is not a list')
  assert.deepEqual(parseProviderList('qwen-token-plan-cn/qwen3.8-flash \u2014 Qwen3.8 Flash'), [], 'a model line is not a provider line')
  assert.deepEqual(parseProviderList('provider - name'), [], 'a hyphen separator must not parse')
  assert.deepEqual(parseProviderList(''), [])
  assert.deepEqual(parseProviderList(undefined), [])
  assert.deepEqual(parseProviderList(42), [])
})

/* ------------------------------------------------------------------ */
/* model list                                                          */
/* ------------------------------------------------------------------ */

test('parseModelList reads the native model lines, with and without a description', () => {
  const text = [
    'qwen-token-plan-cn/qwen3.8-flash \u2014 Qwen3.8 Flash',
    'qwen-token-plan-cn/qwen3.8-max \u2014 Qwen3.8 Max: largest of the family',
  ].join('\n')
  assert.deepEqual(parseModelList(text), [
    { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', name: 'Qwen3.8 Flash', description: null },
    { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max', name: 'Qwen3.8 Max', description: 'largest of the family' },
  ])
})

test('parseModelList splits only the FIRST separator of each line', () => {
  // Real ids and descriptions contain hyphens, dots, digits and colons; only
  // the first `' — '` and the first `': '` are structural.
  const text = 'p/deepseek-v4-flash-0731 \u2014 DeepSeek V4 Flash 0731: cheap, verbose: 1M context'
  assert.deepEqual(parseModelList(text), [
    {
      provider: 'p',
      model: 'deepseek-v4-flash-0731',
      name: 'DeepSeek V4 Flash 0731',
      description: 'cheap, verbose: 1M context',
    },
  ])
})

test('parseModelList returns [] when ANY line is unparseable', () => {
  // A partial parse would let the plugin attribute facts to the wrong route.
  const text = 'p/a \u2014 A\nthis line is prose, not a route'
  assert.deepEqual(parseModelList(text), [])
})

test('parseModelList rejects the literal empty results and non-lists', () => {
  assert.deepEqual(parseModelList('(no advertised models for qwen-token-plan-cn)'), [])
  assert.deepEqual(parseModelList('(no LLM providers)'), [])
  assert.deepEqual(parseModelList('p \u2014 Provider'), [], 'a provider line is not a model line')
  assert.deepEqual(parseModelList('p/m \u2014 '), [], 'a missing name is not a model line')
  assert.deepEqual(parseModelList('/m \u2014 M'), [], 'a missing provider is not a model line')
  assert.deepEqual(parseModelList('p/ \u2014 M'), [], 'a missing model id is not a model line')
  assert.deepEqual(parseModelList(null), [])
})

test('parseModelList is total: it never throws on hostile input', () => {
  for (const value of ['\u2014', ' \u2014 ', 'a/b \u2014 c\nd/e \u2014 f', { text: 'x' }, Symbol.iterator]) {
    assert.doesNotThrow(() => parseModelList(value))
  }
})

/* ------------------------------------------------------------------ */
/* model detail                                                        */
/* ------------------------------------------------------------------ */

test('parseModelDetail preserves the reasoning block byte-for-byte', () => {
  const text = [
    'qwen-token-plan-cn/qwen3.8-flash \u2014 Qwen3.8 Flash',
    'Reasoning efforts:',
    'low \u2014 Low',
    'medium \u2014 Medium',
    'xhigh \u2014 Xhigh',
  ].join('\n')
  const detail = parseModelDetail(text)
  assert.ok(detail, 'the detail must parse')
  assert.equal(detail.provider, 'qwen-token-plan-cn')
  assert.equal(detail.model, 'qwen3.8-flash')
  assert.equal(detail.name, 'Qwen3.8 Flash')
  assert.equal(detail.description, null)
  // Byte-for-byte: the renderer re-emits this substring unchanged.
  assert.equal(detail.reasoningSyntax, text.slice(text.indexOf('Reasoning efforts:')))
  assert.equal(detail.reasoningSyntax.split('\n')[0], 'Reasoning efforts:')
})

test('parseModelDetail preserves a description and the empty-effort literal', () => {
  const text = 'p/m \u2014 M: does one thing\nReasoning efforts:\n(no advertised reasoning efforts)'
  const detail = parseModelDetail(text)
  assert.ok(detail)
  assert.equal(detail.description, 'does one thing')
  assert.equal(detail.reasoningSyntax, 'Reasoning efforts:\n(no advertised reasoning efforts)')
})

test('parseModelDetail accepts a bare model line with no reasoning block', () => {
  const detail = parseModelDetail('p/m \u2014 M')
  assert.ok(detail)
  assert.equal(detail.reasoningSyntax, null)
})

test('parseModelDetail rejects a mojibake reasoning block instead of guessing', () => {
  // A second body line that is not the header means this is not the detail
  // shape the native tool renders.
  assert.equal(parseModelDetail('p/m \u2014 M\nsome other header\nlow \u2014 Low'), null)
  assert.equal(parseModelDetail('p/m \u2014 M\nReasoning efforts:\nprose without a separator'), null)
})

test('parseModelDetail rejects non-detail text', () => {
  assert.equal(parseModelDetail('(no LLM providers)'), null)
  assert.equal(parseModelDetail('p/a \u2014 A\nq/b \u2014 B'), null, 'two model lines are not a detail')
  assert.equal(parseModelDetail(''), null)
  assert.equal(parseModelDetail(undefined), null)
  assert.equal(parseModelDetail(7), null)
})

/* ------------------------------------------------------------------ */
/* content helpers                                                     */
/* ------------------------------------------------------------------ */

test('extractText joins text blocks and ignores everything else', () => {
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(extractText([{ type: 'image' }]), '')
  assert.equal(extractText([]), '')
  assert.equal(extractText(null), '')
  assert.equal(extractText('a'), '')
  assert.equal(extractText([{ type: 'text' }]), '', 'a text block without text contributes nothing')
})

test('the native tool name is the one the plugin intercepts', () => {
  assert.equal(NATIVE_TOOL_NAME, 'list_subagent_models')
  assert.ok(!NATIVE_TOOL_NAME.includes(EM_DASH), 'sanity: the tool name carries no separator')
})

/**
 * `lib/model-id.js` — canonicalisation, AA slug candidates, alias-table loading.
 *
 * Every case here is offline: the only I/O is the shipped alias table and
 * temporary fixtures written under the OS temp directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { aaSlugCandidates, loadAliases, normalizeModelId } from '../lib/model-id.js'

test('normalizeModelId canonicalises the dotted-version form', () => {
  assert.equal(normalizeModelId('qwen3.8-flash'), 'qwen3-8-flash')
  assert.equal(normalizeModelId('gpt-5.6-luna'), 'gpt-5-6-luna')
  assert.equal(normalizeModelId('llama-3.1-70b'), 'llama-3-1-70b')
})

test('normalizeModelId leaves a digit-to-letter name intact', () => {
  // Regression: a blanket digit→letter split turned this into the non-existent
  // `gpt-oss-120-b`, which would make every AA lookup miss.
  assert.equal(normalizeModelId('gpt-oss-120b'), 'gpt-oss-120b')
  assert.equal(normalizeModelId('llama-3-70b'), 'llama-3-70b')
  assert.equal(normalizeModelId('gpt-4o'), 'gpt-4o')
})

test('normalizeModelId lowercases, strips a provider prefix and folds separators', () => {
  assert.equal(normalizeModelId('Qwen3.8-Flash'), 'qwen3-8-flash')
  assert.equal(normalizeModelId('qwen-token-plan-cn/qwen3.8-flash'), 'qwen3-8-flash')
  assert.equal(normalizeModelId('a/b/qwen3.8-flash'), 'qwen3-8-flash')
  assert.equal(normalizeModelId('  qwen_3 8_flash  '), 'qwen-3-8-flash')
  assert.equal(normalizeModelId('deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(normalizeModelId('qwen3-8-flash-next'), 'qwen3-8-flash-next')
})

test('normalizeModelId is total', () => {
  assert.equal(normalizeModelId(''), '')
  assert.equal(normalizeModelId('   '), '')
  assert.equal(normalizeModelId(undefined), '')
  assert.equal(normalizeModelId(null), '')
  assert.equal(normalizeModelId(42), '')
  assert.equal(normalizeModelId({}), '')
  assert.equal(normalizeModelId(['a']), '')
})

test('aaSlugCandidates puts the shipped alias first', () => {
  const candidates = aaSlugCandidates('qwen3.8-flash')
  assert.equal(candidates[0], 'qwen3-8-flash-next', 'the alias must be probed before the literal id')
  assert.ok(candidates.includes('qwen3-8-flash'), 'the literal form is still probed')
})

test('the shipped alias table carries both production mappings', () => {
  const shipped = loadAliases(fileURLToPath(new URL('../data/aliases.json', import.meta.url)))
  assert.equal(shipped['qwen3.8-flash'], 'qwen3-8-flash-next')
  assert.equal(shipped['deepseek-flash'], 'deepseek-v4-1-flash')
})

test('aaSlugCandidates puts the deepseek alias first', () => {
  const candidates = aaSlugCandidates('deepseek-flash')
  assert.equal(candidates[0], 'deepseek-v4-1-flash', 'the alias must be probed before the literal id')
  assert.ok(candidates.includes('deepseek-flash'), 'the literal form is still probed')
})

test('aaSlugCandidates keeps identity first when no alias exists', () => {
  const candidates = aaSlugCandidates('deepseek-v4-flash')
  assert.equal(candidates[0], 'deepseek-v4-flash')
  assert.ok(candidates.includes('deepseek-v4-flash-next'), 'the preview/production heuristic is offered last')
})

test('aaSlugCandidates strips a trailing build stamp and never re-adds "-next"', () => {
  const dated = aaSlugCandidates('kimi-k2-0905')
  assert.ok(dated.includes('kimi-k2-0905'))
  assert.ok(dated.includes('kimi-k2'), 'the 4-digit build stamp is strippable')
  const already = aaSlugCandidates('qwen3-8-flash-next')
  assert.deepEqual(already, ['qwen3-8-flash-next'], 'an id that already ends in -next yields only itself')
})

test('aaSlugCandidates dedupes and is bounded and total', () => {
  const candidates = aaSlugCandidates('Qwen3.8-Flash')
  assert.equal(new Set(candidates).size, candidates.length, 'candidates are unique')
  assert.ok(candidates.length <= 6, 'candidates are capped')
  assert.deepEqual(aaSlugCandidates(''), [])
  assert.deepEqual(aaSlugCandidates(undefined), [])
  assert.deepEqual(aaSlugCandidates(null), [])
})

test('loadAliases tolerates every broken input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'better-subagents-'))
  try {
    assert.deepEqual(loadAliases(join(dir, 'missing.json')), {})
    assert.deepEqual(loadAliases(''), {})
    assert.deepEqual(loadAliases(undefined), {})
    assert.deepEqual(loadAliases(dir), {}, 'a directory is not an alias table')

    const invalid = join(dir, 'invalid.json')
    writeFileSync(invalid, '{ not json')
    assert.deepEqual(loadAliases(invalid), {})

    const wrappedWrong = join(dir, 'wrong.json')
    writeFileSync(wrappedWrong, JSON.stringify({ aliases: 'nope' }))
    assert.deepEqual(loadAliases(wrappedWrong), {}, 'a declared-but-non-object aliases value is malformed')

    const arrayDoc = join(dir, 'array.json')
    writeFileSync(arrayDoc, JSON.stringify(['a']))
    assert.deepEqual(loadAliases(arrayDoc), {})

    const bare = join(dir, 'bare.json')
    writeFileSync(bare, JSON.stringify({ version: 9, note: 'skip me', 'qwen3.8-flash': 'qwen3-8-flash-next', bad: 3 }))
    assert.deepEqual(loadAliases(bare), { 'qwen3.8-flash': 'qwen3-8-flash-next' })

    const wrapped = join(dir, 'wrapped.json')
    writeFileSync(wrapped, JSON.stringify({ version: 1, aliases: { 'a.b': 'a-b' } }))
    assert.deepEqual(loadAliases(wrapped), { 'a.b': 'a-b' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadAliases keeps a __proto__ key inert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'better-subagents-'))
  try {
    const file = join(dir, 'proto.json')
    writeFileSync(file, '{"aliases":{"__proto__":"evil"}}')
    const table = loadAliases(file)
    assert.equal(Object.getPrototypeOf(table), Object.prototype, 'the result is a plain object')
    assert.equal({}.evil, undefined, 'Object.prototype was not polluted')
    assert.equal(Object.hasOwn(table, '__proto__'), true, 'the key stays own data')
    assert.equal(table.__proto__, 'evil')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

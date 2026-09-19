/* Session-scoped authorization for child LLM routes.
 *
 * The plugin must never advertise a route the calling Session cannot delegate
 * to, and must never guess when it cannot tell. Both halves are asserted here:
 * the projection read, the `snapshotEvents()` fallback, and — most importantly
 * — that every undeterminable shape collapses to `undefined`, which the
 * enrichment handler treats as "leave the tool result exactly as it was".
 *
 * Fully offline; `lib/authorization.js` imports nothing and performs no I/O.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { authorizedRoutes } from '../lib/authorization.js'

const POLICY_EVENT = 'subagent/model-selection-policy'

/**
 * Build a fake ctx/exec pair around a session.
 *
 * @param {object} options Fixture options.
 * @returns {{ ctx: object, exec: object }} The pair to pass to authorizedRoutes.
 */
function fixture({ session, projections, agents, sessions, agent = true } = {}) {
  const services = new Map()
  if (projections !== undefined) services.set('sessionProjections', projections)
  if (agents !== undefined) services.set('agents', agents)
  if (sessions !== undefined) services.set('sessions', sessions)
  const ctx = {
    get(name) {
      return services.get(name)
    },
  }
  const exec = agent === false ? {} : { name: 'list_subagent_models', agent: { id: 'a1', session } }
  return { ctx, exec }
}

/** A session whose event log is the given array. */
function sessionWithEvents(events) {
  return { snapshotEvents: () => events }
}

/** A projection registry answering one fixed value for every key. */
function projectionsReturning(value) {
  return { stateOf: () => value }
}

/* ------------------------------------------------------------------ */
/* projection read                                                     */
/* ------------------------------------------------------------------ */

test('an array projection is returned as detached copies', () => {
  const live = [
    { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  ]
  const { ctx, exec } = fixture({ session: sessionWithEvents([]), projections: projectionsReturning(live) })
  const routes = authorizedRoutes(ctx, exec)
  assert.deepEqual(routes, [
    { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  ])
  // The projection value is LIVE registry state: mutating the result must not
  // touch it, and the entries must not be the same objects.
  assert.notEqual(routes, live)
  assert.notEqual(routes[0], live[0])
  routes[0].provider = 'mutated'
  routes.push({ provider: 'x', model: 'y' })
  assert.equal(live[0].provider, 'qwen-token-plan-cn')
  assert.equal(live.length, 2)
})

test('an empty array projection means "authorized for nothing", not "unknown"', () => {
  const { ctx, exec } = fixture({ session: sessionWithEvents([]), projections: projectionsReturning([]) })
  assert.deepEqual(authorizedRoutes(ctx, exec), [])
})

test('malformed route entries are dropped rather than repaired', () => {
  const live = [
    { provider: 'p', model: 'm' },
    { provider: '', model: 'm' },
    { provider: 'p', model: '' },
    { provider: 'p' },
    { model: 'm' },
    null,
    'p/m',
    { provider: 'p', model: 7 },
  ]
  const { ctx, exec } = fixture({ session: sessionWithEvents([]), projections: projectionsReturning(live) })
  assert.deepEqual(authorizedRoutes(ctx, exec), [{ provider: 'p', model: 'm' }])
})

test('a null projection (registered, no recorded policy) falls through to the log', () => {
  const session = sessionWithEvents([{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'p', model: 'm' }] } }])
  const { ctx, exec } = fixture({ session, projections: projectionsReturning(null) })
  assert.deepEqual(authorizedRoutes(ctx, exec), [{ provider: 'p', model: 'm' }])
})

test('an unregistered key (undefined) falls through to the log', () => {
  const session = sessionWithEvents([{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'logged', model: 'm' }] } }])
  const { ctx, exec } = fixture({ session, projections: projectionsReturning(undefined) })
  assert.deepEqual(authorizedRoutes(ctx, exec), [{ provider: 'logged', model: 'm' }])
})

test('a throwing stateOf is swallowed and the log still decides', () => {
  const session = sessionWithEvents([{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'p', model: 'm' }] } }])
  const projections = {
    stateOf() {
      throw new Error('projection fold exploded')
    },
  }
  const { ctx, exec } = fixture({ session, projections })
  assert.deepEqual(authorizedRoutes(ctx, exec), [{ provider: 'p', model: 'm' }])
})

/* ------------------------------------------------------------------ */
/* log scan                                                            */
/* ------------------------------------------------------------------ */

test('the log scan takes the FIRST policy event, matching the projection fold', () => {
  const session = sessionWithEvents([
    { type: 'some/other-event', data: { allowedModels: [{ provider: 'ignored', model: 'm' }] } },
    { type: POLICY_EVENT, data: { allowedModels: [{ provider: 'first', model: 'm' }] } },
    { type: POLICY_EVENT, data: { allowedModels: [{ provider: 'second', model: 'm' }] } },
  ])
  const { ctx, exec } = fixture({ session, projections: projectionsReturning(undefined) })
  assert.deepEqual(authorizedRoutes(ctx, exec), [{ provider: 'first', model: 'm' }])
})

test('a malformed FIRST policy event does not promote a later one', () => {
  // The projection is first-wins, so a malformed first event means the
  // session's real authorization was never recorded. Reading the second event
  // would invent authority.
  const session = sessionWithEvents([
    { type: POLICY_EVENT, data: { allowedModels: 'not-an-array' } },
    { type: POLICY_EVENT, data: { allowedModels: [{ provider: 'second', model: 'm' }] } },
  ])
  const { ctx, exec } = fixture({ session, projections: projectionsReturning(undefined) })
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

test('a log with no policy event is unknown, not empty', () => {
  const { ctx, exec } = fixture({ session: sessionWithEvents([{ type: 'tool/call' }]), projections: projectionsReturning(undefined) })
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

test('a throwing snapshotEvents is swallowed', () => {
  const session = {
    snapshotEvents() {
      throw new Error('log unavailable')
    },
  }
  const { ctx, exec } = fixture({ session })
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

test('hostile event shapes are ignored, never thrown on', () => {
  const session = sessionWithEvents([null, 42, 'event', { type: POLICY_EVENT }, { type: POLICY_EVENT, data: null }])
  const { ctx, exec } = fixture({ session })
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

/* ------------------------------------------------------------------ */
/* session resolution and fail-closed behaviour                        */
/* ------------------------------------------------------------------ */

test('no agent at all is unknown', () => {
  const { ctx, exec } = fixture({ agent: false })
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

test('an agent with no session falls back to the services, then gives up', () => {
  const { ctx } = fixture({ agent: false })
  assert.equal(authorizedRoutes(ctx, { name: 'list_subagent_models', agent: { id: 'a1' } }), undefined)
})

test('an agent id resolves through the agents service', () => {
  const session = sessionWithEvents([{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'p', model: 'm' }] } }])
  const agents = {
    get(id) {
      assert.equal(id, 'a1')
      return { session }
    },
  }
  const { ctx, exec } = fixture({ agents })
  assert.deepEqual(authorizedRoutes(ctx, { ...exec, agent: { id: 'a1' } }), [{ provider: 'p', model: 'm' }])
})

test('an agent id resolves through the sessions service when agents does not have it', () => {
  const session = sessionWithEvents([{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'p', model: 'm' }] } }])
  const { ctx, exec } = fixture({ agents: { get: () => undefined }, sessions: { get: () => session } })
  assert.deepEqual(authorizedRoutes(ctx, { ...exec, agent: { id: 'a1' } }), [{ provider: 'p', model: 'm' }])
})

test('throwing services are swallowed', () => {
  const { ctx, exec } = fixture({
    agents: {
      get() {
        throw new Error('registry offline')
      },
    },
    sessions: {
      get() {
        throw new Error('registry offline')
      },
    },
  })
  assert.equal(authorizedRoutes(ctx, { ...exec, agent: { id: 'a1' } }), undefined)
})

test('a throwing ctx.get is swallowed', () => {
  const ctx = {
    get() {
      throw new Error('fiber disposed')
    },
  }
  const exec = { agent: { id: 'a1' } }
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

test('the hook is total: unknown garbage in yields undefined out', () => {
  assert.equal(authorizedRoutes(undefined, undefined), undefined)
  assert.equal(authorizedRoutes(null, null), undefined)
  assert.equal(authorizedRoutes({}, {}), undefined)
  assert.equal(authorizedRoutes('ctx', 'exec'), undefined)
  assert.equal(authorizedRoutes(undefined, { agent: null }), undefined)
  // A session whose accessor itself throws must not escape.
  const ctx = { get: () => ({ stateOf: () => [{ provider: 'p', model: 'm' }] }) }
  const exec = {
    get agent() {
      throw new Error('agent accessor exploded')
    },
  }
  assert.equal(authorizedRoutes(ctx, exec), undefined)
})

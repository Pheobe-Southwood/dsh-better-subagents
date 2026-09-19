/**
 * Session-scoped authorization for child LLM routes.
 *
 * The native `list_subagent_models` tool only ever lists routes the calling
 * Session is allowed to delegate to. A plugin that appends facts about OTHER
 * routes would therefore advertise capability the model does not have, so every
 * lookup this plugin performs must first be checked against the durable policy
 * of the session that issued the call.
 *
 * Authorization comes from the durable Session event
 * `subagent/model-selection-policy` (`{ allowedModels: [{ provider, model }] }`),
 * registered by `@deepseek-ai/dsh-tool-subagent` as the session projection key
 * `subagentModelSelectionPolicy`. Two reads are attempted, in order:
 *
 * 1. `ctx.sessionProjections.stateOf(session, 'subagentModelSelectionPolicy')`.
 * 2. A scan of `session.snapshotEvents()` for the FIRST
 *    `subagent/model-selection-policy` event.
 *
 * The projection definition is first-wins: `apply` returns the recorded array
 * and ignores every later event, and the whole projection folds to `null` when
 * this Session recorded no policy at all. `stateOf` returns `undefined` when the
 * key is not registered (the tool-subagent plugin is not mounted) and `null`
 * when it is registered but this Session has no policy. `null` implies the
 * native tool is not registered for this Session — so this hook can never fire
 * for it — but both values fall through to the log scan anyway: the scan is the
 * only remaining authority when the projection registry is absent or disposed,
 * and it is harmless when it finds nothing.
 *
 * Note deliberately NOT used here: the `subagentModelSelection` service's
 * `current()`. That value is the live HOST preference, sampled once for a fresh
 * top-level session; it is never rewritten into an existing session, so it is
 * not this Session's authorization.
 *
 * @module dsh-better-subagents/authorization
 */

/** Durable Session event type carrying the delegation policy. */
const POLICY_EVENT = 'subagent/model-selection-policy'

/** Session projection key registered by `@deepseek-ai/dsh-tool-subagent`. */
const POLICY_KEY = 'subagentModelSelectionPolicy'

/**
 * Copy a route list into a detached `[{ provider, model }]` array.
 *
 * The projection value is live registry state and must never be mutated or
 * retained, so every entry is copied. Entries that cannot describe a route are
 * dropped rather than repaired.
 *
 * @param {unknown} routes - live or logged route list.
 * @returns {{ provider: string, model: string }[]} detached copies.
 */
function copyRoutes(routes) {
  if (!Array.isArray(routes)) return []
  const copied = []
  for (const route of routes) {
    if (route === null || typeof route !== 'object') continue
    const { provider, model } = route
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    copied.push({ provider, model })
  }
  return copied
}

/**
 * Resolve the Session that issued one tool call.
 *
 * `exec.agent.session` is the most robust read (the live Agent exposes
 * `readonly session: Session`); the service lookups are fallbacks for call
 * shapes that carry only an agent id.
 *
 * @param {any} ctx - plugin context.
 * @param {any} exec - tool execution.
 * @returns {any} the Session, or `undefined` when it cannot be determined.
 */
function resolveSession(ctx, exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return undefined
  try {
    if (agent.session !== undefined && agent.session !== null) return agent.session
  } catch {
    // Fall through to the id-based lookups.
  }
  const agentId = agent.id
  if (agentId === undefined || agentId === null) return undefined
  try {
    const agents = ctx?.get?.('agents')
    const live = agents?.get?.(agentId)
    if (live?.session !== undefined && live.session !== null) return live.session
  } catch {
    // Fall through to the sessions service.
  }
  try {
    const sessions = ctx?.get?.('sessions')
    const session = sessions?.get?.(agentId)
    if (session !== undefined && session !== null) return session
  } catch {
    // No session available through either service.
  }
  return undefined
}

/**
 * Read the route policy recorded in the Session event log.
 *
 * @param {any} session - the calling Session.
 * @returns {{ provider: string, model: string }[]|undefined} the FIRST recorded
 *   policy, or `undefined` when no policy event exists.
 */
function scanSessionLog(session) {
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== POLICY_EVENT) continue
    const allowed = event.data?.allowedModels
    if (Array.isArray(allowed)) return copyRoutes(allowed)
    // First-wins: the projection folds only the FIRST matching event, so a
    // malformed first event means later events were never authoritative.
    return undefined
  }
  return undefined
}

/**
 * Determine the exact LLM routes the calling Session may delegate to.
 *
 * Never throws. The result distinguishes three outcomes the caller must treat
 * differently:
 *
 * - `undefined` — authorization is UNKNOWN (no session, no projection registry,
 *   no logged policy, or an unexpected shape). The caller must leave the native
 *   result untouched rather than guess.
 * - `[]` — authorization is known to be empty; nothing may be enriched.
 * - `[{ provider, model }]` — the exact authorized routes, detached copies.
 *
 * @param {any} ctx - plugin context.
 * @param {any} exec - tool execution carrying the calling agent.
 * @returns {{ provider: string, model: string }[]|undefined} authorized routes.
 */
export function authorizedRoutes(ctx, exec) {
  try {
    const session = resolveSession(ctx, exec)
    if (session === undefined) return undefined

    let projections
    try {
      projections = ctx?.get?.('sessionProjections')
    } catch {
      projections = undefined
    }

    if (projections !== undefined && projections !== null && typeof projections.stateOf === 'function') {
      let state
      try {
        state = projections.stateOf(session, POLICY_KEY)
      } catch {
        state = undefined
      }
      if (Array.isArray(state)) return copyRoutes(state)
      // `undefined` (key not registered) and `null` (registered, no recorded
      // policy) both fall through to the log scan; see the module JSDoc.
    }

    return scanSessionLog(session)
  } catch {
    return undefined
  }
}

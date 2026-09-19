/**
 * dsh-better-subagents — host half (Cordis entry).
 *
 * The plugin does one thing: it subscribes to the native `tools/post-execute`
 * waterfall and, when the tool that just ran is `list_subagent_models`, appends
 * an authoritative model profile (Artificial Analysis scores, real USD token
 * prices, context window, speed, reasoning levels) to that tool's result, so a
 * delegating agent chooses a subagent model from data instead of from a name.
 *
 * It publishes no service, has no client half and holds no runtime state of its
 * own: `install()` owns the listener and everything it caches, and Cordis
 * removes all of it when this fiber stops.
 */
import { install } from './post-execute.js'

/**
 * Must equal the `id` of the row in `cordis.patch.yml` — the Loader uses it to
 * recognise the row and the plugin as the same thing.
 */
export const name = 'better-subagents'

/**
 * `tools` is a hard dependency: `tools/post-execute` is published by the tools
 * service, so there is nothing to subscribe to before it exists. Declaring it
 * makes Cordis hold this plugin in "waiting" and activate it once the service
 * appears, instead of silently installing into an empty registry.
 */
export const inject = ['tools']

export { Config } from './index-config.js'

/**
 * Report an activation problem without becoming one.
 *
 * A missing or throwing logger must not turn "no enrichment" into a failed
 * boot, so this reporter is total: it swallows its own failures.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin fiber context.
 * @param {'info'|'error'} level Log level to attempt.
 * @param {string} message Line to log.
 * @returns {void}
 */
function report(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(message)
  } catch {
    // Logging is advisory here; there is nothing left to report the failure to.
  }
}

/**
 * Cordis entry point.
 *
 * `install` is imported statically on purpose: a broken enricher should fail
 * loudly at load time rather than half-mount a plugin whose listener never
 * arrives. It is the only module of this package that the entry pull in, and it
 * is responsible for registering the `tools/post-execute` listener
 * SYNCHRONOUSLY, before its first `await` — the listener must belong to this
 * plugin's fiber from the first tick, not after an asynchronous load step.
 * `install()` returns a promise only because it may read the optional Artificial
 * Analysis snapshot from disk.
 *
 * `apply` stays synchronous and NEVER throws: a rejected setup promise and a
 * synchronous throw out of `install()` (a context without `on`, a registry that
 * refuses the listener) take the same path, so an enricher that fails to install
 * degrades to "no enrichment", never to a failed boot.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin fiber context.
 * @param {import('./index-config.js').BetterSubagentsConfig} config Resolved row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    report(
      ctx,
      'info',
      '[better-subagents] disabled by configuration — the list_subagent_models result stays untouched',
    )
    return
  }

  try {
    install(ctx, config).catch((error) => {
      report(ctx, 'error', `[better-subagents] activation failed: ${error?.message ?? error}`)
    })
  } catch (error) {
    report(ctx, 'error', `[better-subagents] activation failed: ${error?.message ?? error}`)
  }
}

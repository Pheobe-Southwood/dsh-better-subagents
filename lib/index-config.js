/**
 * The `config:` contract of the better-subagents row.
 *
 * Every field below has a Schemastery default, so the object reaching
 * `apply()` is always complete: `post-execute.js` may read `config.timeoutMs`
 * directly instead of falling back per field. A profile changes behaviour by
 * adding a `config:` block to the row in its own patch layer; nothing here is
 * required, and an empty `config: {}` yields exactly the defaults below.
 *
 * No field is secret: the Artificial Analysis key is *named* by
 * `aa.credentialRef` and read from the harness credential store at call time,
 * never stored in the profile.
 */
import z from '@deepseek-ai/schemastery'

/**
 * The resolved configuration.
 *
 * Schemastery fills every default, so all properties are present at runtime.
 *
 * @typedef {object} BetterSubagentsConfig
 * @property {boolean} enabled Master switch. `false` logs one line and installs
 *   no listener at all, so the plugin costs nothing.
 * @property {number} timeoutMs Network budget for one lookup, in ms. `0`
 *   turns every network path off while still consulting the local sources:
 *   `profiles` and, when `aa.snapshotPath` names a readable file, that
 *   snapshot. A miss then reports `offline` rather than pretending the model
 *   was never measured.
 * @property {number} cacheTtlMs How long a successful profile is reused, in ms.
 *   Default 21600000 (6 hours).
 * @property {number} failureTtlMs How long a failed lookup is remembered before
 *   it is retried, in ms. Default 600000 (10 minutes).
 * @property {boolean} webSearch Last-resort confirmation through the released
 *   `ctx.web` search surface, used only when `aa.enabled` is true, the Artificial
 *   Analysis lookup failed outright, and no other layer produced a score. The
 *   query targets the model's Artificial Analysis profile, and a result is
 *   accepted ONLY when one of its source URLs is on `artificialanalysis.ai` —
 *   search output is untrusted input and no score is ever taken from another
 *   host. The path spends the same `timeoutMs` budget, never throws, and
 *   degrades to "no profile". Off by default.
 * @property {boolean} showWhenToUse Whether `whenToUse` / `whenNotTo` prose is
 *   rendered into the enriched tool result.
 * @property {boolean} debugLog Whether the enricher logs its lookup decisions
 *   (candidate slugs, cache hits, miss reasons) through `ctx.logger`.
 * @property {BetterSubagentsAaConfig} aa
 * @property {Record<string, BetterSubagentsProfile>} profiles Hand-written
 *   profiles merged over the live lookup, keyed by normalized model id (or AA
 *   slug; see `lib/model-id.js`).
 */

/**
 * Artificial Analysis lookup settings.
 *
 * @typedef {object} BetterSubagentsAaConfig
 * @property {boolean} enabled Whether AA lookup happens at all.
 * @property {string} credentialRef Name of the credential holding the AA API
 *   key, resolved through the harness credential store. Never the key itself.
 * @property {number} indexPages How many AA index pages the crawler walks when
 *   looking for a model (1 page = the newest slice).
 * @property {string} snapshotPath Optional path to a locally synced snapshot
 *   (`data/aa-snapshot.json` by convention). Empty means "use the packaged
 *   default location, if present". Snapshots are never redistributed — see
 *   `.gitignore` — so this is normally empty in a clean checkout.
 */

/**
 * One model profile, as written by hand or produced by `bin/sync-aa.mjs`.
 *
 * @typedef {object} BetterSubagentsProfile
 * @property {number} score Artificial Analysis intelligence index score.
 * @property {string} scoreName Name of the index the score comes from, e.g.
 *   `Artificial Analysis Intelligence Index`.
 * @property {string} scoreVersion Version/variant of that index, e.g. `v3.0`.
 * @property {number} inputPer1M USD per 1M input tokens.
 * @property {number} outputPer1M USD per 1M output tokens.
 * @property {number} cacheReadPer1M USD per 1M cached input tokens.
 * @property {number} contextWindow Context window in tokens.
 * @property {string} note Free-form caveat rendered with the profile.
 * @property {string} whenToUse Guidance for choosing this model.
 * @property {string} whenNotTo Guidance against choosing it.
 * @property {string} sourceUrl Where the numbers came from.
 * @property {string} generatedAt ISO timestamp of the last refresh.
 * @property {boolean} resolve Whether name resolution may rewrite/complete this
 *   entry from the live AA lookup.
 */

export const Config = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.natural().default(8000),
  cacheTtlMs: z.natural().default(21600000),
  failureTtlMs: z.natural().default(600000),
  webSearch: z.boolean().default(false),
  showWhenToUse: z.boolean().default(true),
  debugLog: z.boolean().default(false),
  aa: z
    .object({
      enabled: z.boolean().default(true),
      credentialRef: z.string().default('AA_API_KEY'),
      // 1-20 is what lib/aa/client.js walks in one refresh; the schema is the
      // loud gate for a profile author, and the client keeps its own clamp as
      // defence for programmatic callers that bypass validation.
      indexPages: z.natural().min(1).max(20).default(5),
      snapshotPath: z.string().default(''),
    })
    .default({}),
  profiles: z
    .dict(
      z.object({
        score: z.number(),
        scoreName: z.string(),
        scoreVersion: z.string(),
        inputPer1M: z.number(),
        outputPer1M: z.number(),
        cacheReadPer1M: z.number(),
        contextWindow: z.natural(),
        note: z.string(),
        whenToUse: z.string(),
        whenNotTo: z.string(),
        sourceUrl: z.string(),
        generatedAt: z.string(),
        resolve: z.boolean(),
      }),
    )
    .default({}),
})

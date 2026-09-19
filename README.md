# dsh-better-subagents

Authoritative model profiles for DeepSeek Harness (dsh) subagent delegation.

The harness ships a native, model-facing tool — `list_subagent_models`,
registered by `@deepseek-ai/dsh-tool-subagent` — that answers with bare
identifiers, a display name and the reasoning levels a route accepts. It says
nothing about price, context window, speed or what a model is good at, so an
Agent picking a subagent model is choosing from names.

This plugin subscribes to the harness's `tools/post-execute` waterfall and, for
that one tool, appends a profile to the **same tool result the Agent already
reads**: the Artificial Analysis Intelligence Index score, real USD token
prices, the harness's runtime context window and max output, speed, latency,
provenance and the required attribution line. The Agent's call is
unchanged; only what it reads back is richer.

It is a host-plane plugin with **no client half and no runtime dependencies**,
and it never calls an LLM itself — it costs no tokens.

```text
qwen-token-plan-cn/qwen3.8-flash — Qwen3.8 Flash
  score 40.0 (Artificial Analysis Intelligence Index v4.3) · price in/out per 1M:
  subscription route (catalogue rate 0) · context 272,000 · speed 55.5 tok/s
Source URL: https://artificialanalysis.ai/models/qwen3-8-flash-next
Source: Artificial Analysis (artificialanalysis.ai)
```

(The facts are one indented line joined with `·`; it is wrapped above to fit.)

## Precondition — read this first

**The plugin only has something to enrich when the host setting
`subagent-model-selection` is enabled with at least one allowed model.**

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - provider: qwen-token-plan-cn
      model: qwen3.8-flash
    - provider: deepseek-official
      model: deepseek-flash
```

When that setting is off — or its `allowedModels` list is empty —
`dsh-tool-subagent` does not register `list_subagent_models` at all. The tool
does not exist, no call happens, and this plugin is completely inert. It is not
broken in that state; there is simply nothing to enrich. This is the number-one
reason to "see nothing", and it is the first thing to check.

## What it adds, and what it deliberately does not

Appended, per authorized route:

- **Score** — Artificial Analysis Intelligence Index, with the index version AA
  published it under.
- **Price** — USD per 1M input / output / cache-read tokens, in both the compact
  list layout and the single-model dossier layout.
- **Context window and max output** — the harness's own runtime values whenever
  the adapter knows them (see the limits below).
- **Speed and latency** — output tokens per second, and AA's latency figure
  labelled exactly as what it measures.
- **Reasoning levels, input modalities, alias and the user's own `whenToUse` /
  `whenNotTo` prose** — in the single-model dossier layout.
- **Provenance** — a `Source URL:` line naming the page, index or snapshot the
  numbers came from, origin-aware labels (AA's context window is marked
  `(AA, approximate)`), and the attribution line on every render. The merged
  profile also records which layer supplied each fact group, but only these are
  rendered into the conversation.

Not added, on purpose:

- **No leaderboard rank.** Artificial Analysis does not publish a per-model rank
  on its model pages, and this plugin will not invent one: the rank field stays
  empty, so no rank line is rendered at all. The "27 of 653 models" text on
  those pages is a model-picker counter, not a position — the same text appears
  on the page of the index leader and on far weaker models — so all that can be
  read from it is how many models AA tracks. A page that ever spells a real rank
  out ("Ranked 27 of 653") is read and rendered as `rank 27 of 653`.
- **No "free" models.** A catalogue rate of zero on every dimension is a
  subscription plan artifact, not evidence a request costs nothing: it renders
  as `subscription route (catalogue rate 0)`, never as `$0.00` or "free".
- **No guessed numbers.** A measurement no layer supplies is omitted, never
  printed as `0`.

## Install (web profile)

**One command installs and mounts the plugin:**

```bash
dsh plugin --profile web add github:Pheobe-Southwood/dsh-better-subagents
```

Then restart `dsh --profile web` once. There is no second step: this package
declares `dsh.bundle.patch` in `package.json`, so the dsh CLI's reconcile step
appends it to the profile's `dsh.profile.bundles`, and the package's own
`cordis.patch.yml` contributes the plugin row (`id: better-subagents`,
`name: dsh-better-subagents`).

**Do not hand-edit the profile's `cordis.patch.yml`** — the package already
ships that row. A second copy of the same row is not a harmless duplicate: the
include inserts rows verbatim and the Loader rejects a repeated entry id, so the
next boot fails loudly with

```text
duplicate loader entry id: better-subagents
```

If you are upgrading from a hand-wired install, run the `add` command above and
then delete your hand-written `better-subagents` insert block, leaving every
other entry in that file untouched. The package's own layer takes over.

Self-check after a restart:

```bash
dsh --profile web --dump-config | grep -A 1 '== dsh-better-subagents'
#   # == dsh-better-subagents
#   - id: better-subagents
#     name: dsh-better-subagents
```

### Other install shapes

```bash
# a local checkout (the mount is identical, only the spec differs)
dsh plugin --profile web add link:/path/to/dsh-better-subagents

# from npm (requires the package to be published first)
dsh plugin --profile web add dsh-better-subagents

# from a tarball built in this repository
npm pack
dsh plugin --profile web add ./dsh-better-subagents-0.1.0.tgz
```

Uninstall is symmetric — reconcile also drops the bundle from
`dsh.profile.bundles`:

```bash
dsh plugin --profile web remove dsh-better-subagents
```

## Where you see it

In any session whose preset mounts the delegation tools, ask the Agent to list
the subagent models it can use. The Agent's `list_subagent_models` call is
unchanged; the result it reads back is the enriched one. The profile is
conversation text in that tool result — nothing is written to disk and nothing
is stored anywhere.

Routes the calling Session is **not** authorized to delegate to stay in the
native output, annotated and never looked up:

```text
anthropic/claude-sonnet-4 — Claude Sonnet 4 — not authorized for delegation in this Session
```

## Configuration

The row accepts a `config:` block; an empty `config: {}` yields exactly the
defaults below. Every field is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` logs one line and installs no listener at all. |
| `timeoutMs` | `8000` | Network budget for one lookup, in ms. `0` turns every network path off while still consulting the local sources (`profiles` and a readable snapshot); a miss then reports `offline` instead of claiming the model was never measured. |
| `cacheTtlMs` | `21600000` (6 h) | How long a successful profile is reused. |
| `failureTtlMs` | `600000` (10 min) | How long a failed lookup is remembered before it is retried. |
| `webSearch` | `false` | Last-resort confirmation through the released `ctx.web` search surface, used only when the AA lookup failed outright and nothing else carried a score. A result is accepted **only** when one of its source URLs is on `artificialanalysis.ai`; no number is ever read from a snippet. |
| `showWhenToUse` | `true` | Whether `whenToUse` / `whenNotTo` prose is rendered into the enriched result. |
| `debugLog` | `false` | Log lookup decisions (candidate slugs, cache hits, miss reasons) through `ctx.logger`. |
| `aa.enabled` | `true` | Whether Artificial Analysis lookup happens at all. |
| `aa.credentialRef` | `"AA_API_KEY"` | The credential **name** to resolve through the harness credential store. Never the key itself. |
| `aa.indexPages` | `5` (1–20) | How many AA index pages one Free-tier refresh walks. |
| `aa.snapshotPath` | `""` | Optional path to a locally synced snapshot. Empty means "use the packaged default location, if present". |
| `profiles` | `{}` | Hand-written per-route overrides. |

### Overriding a route: `config.profiles`

Overrides are the escape hatch when a model is not on Artificial Analysis, when
AA has no measurement for it, or when you disagree with a value. A profile is
keyed by `provider/model` (or by the normalized model id / AA slug) and **wins
over every inferred layer for the fields it sets**.

```yaml
- id: better-subagents
  name: dsh-better-subagents
  config:
    profiles:
      'qwen-token-plan-cn/qwen3.8-flash':
        score: 40
        scoreName: Artificial Analysis Intelligence Index
        scoreVersion: v4.3
        inputPer1M: 0.15
        outputPer1M: 0.47
        contextWindow: 272000
        sourceUrl: https://artificialanalysis.ai/models/qwen3-8-flash-next
        note: subscription route — per-token catalogue rate is 0 by plan
        whenToUse: long-context drafting where the token plan is already paid for
        whenNotTo: work needing the strongest reasoning available
      # no lookup at all for this route: use only these numbers
      'deepseek-official/deepseek-flash':
        resolve: false
        score: 52
        inputPer1M: 0.28
```

Profile keys: `score`, `scoreName`, `scoreVersion`, `inputPer1M`, `outputPer1M`,
`cacheReadPer1M`, `contextWindow`, `note`, `whenToUse`, `whenNotTo`,
`sourceUrl`, `generatedAt` and `resolve`. Set only what you mean to state:
`resolve: false` skips the whole lookup for that route — no Artificial Analysis
request, no pi-ai catalogue read, no runtime adapter facts — so the entry you
write is exactly what gets rendered.

### Model names Artificial Analysis does not use

`qwen3.8-flash` does not exist on Artificial Analysis. The production model is
published there as **`qwen3-8-flash-next`**; without the mapping, the lookup
404s. This repository carries the one-line alias in `data/aliases.json`:

```json
{
  "version": 1,
  "note": "Local model id -> Artificial Analysis model slug. These are our own name mappings, not Artificial Analysis data.",
  "aliases": { "qwen3.8-flash": "qwen3-8-flash-next" }
}
```

Add your own the same way — the key is the local model id (or its normalized
form) and the value is the slug in the AA model page URL
(`https://artificialanalysis.ai/models/<slug>`). Slugs are tried in order: the
alias table, the normalized id, the id with a trailing build stamp removed, and
last `${normalized}-next` as a documented preview-vs-production heuristic.

## How the lookup works

Per authorized route, three routes are tried in order, and each answer records
where it came from:

1. **The Free-tier index** (`/api/v2/language/models/free`) — used only when a
   credential resolves. The response is cached with a **6-hour floor** whatever
   `cacheTtlMs` says, because the free tier is **100 requests / 24 h** and one
   refresh costs up to `aa.indexPages` requests; a failed index attempt is
   remembered for 5 minutes, and **nothing is ever retried**.
2. **A local snapshot** (`data/aa-snapshot.json`) — network-free, produced by
   `bin/sync-aa.mjs` on a machine that has a key.
3. **The public model page** (`https://artificialanalysis.ai/models/<slug>`) —
   always available and needs no key; the numbers are parsed from the page's
   schema.org JSON-LD `Dataset` blocks.

**The AA API key is optional.** With `AA_API_KEY` resolvable — the process
environment, the harness credential store, or a `.env` behind it — the plugin
uses route 1. Without a key it uses route 3. Both paths degrade to "no profile"
without failing anything. (This deployment currently has no `AA_API_KEY`, so the
page path is what runs out of the box.)

Artificial Analysis is retiring the older `/api/v2/data/llms/models` endpoint on
**2026-11-04**; this plugin already uses its replacement, the Free-tier
`/api/v2/language/models/free`, for keyed lookups.

**No Artificial Analysis data is stored in this repository.** Their Data
Platform Terms forbid embedding their data in a product, so the profile is
fetched at runtime, shown only inside the conversation, and attributed every
time. The optional local snapshot written by `bin/sync-aa.mjs` is gitignored
(`data/aa-snapshot.json`) and is never published.

## Guarantees and failure behaviour

- **Authorization is mandatory.** Only the LLM routes the calling Session is
  actually allowed to delegate to are ever profiled — the Session's frozen
  `subagent/model-selection-policy`, read through `ctx.sessionProjections` and
  falling back to the durable session event log. Anything else in the native
  output is annotated `— not authorized for delegation in this Session` and is
  never looked up.
- **Unknown authorization means no enrichment.** If the calling Session cannot
  be resolved, or no policy was ever recorded, the native result is returned
  unchanged rather than enriched with a guess.
- **Every failure leaves the native result untouched.** Timeout, HTTP error,
  unknown model, unparseable page, missing session — all of them fall back to
  the untouched native text. The listener never throws, because a throwing
  `tools/post-execute` listener would turn a good tool result into an error.
- **No credential is ever logged, embedded or returned.** The key is resolved at
  call time, travels only in AA's `x-api-key` header, and never appears in the
  result, the snapshot, or a log line.
- **No tokens are spent.** The plugin makes no LLM call of any kind.

## Known limits

- **The latency figure is AA's "Time To First Answer Token"** — input processing
  plus model thinking — deliberately *not* a per-chunk time-to-first-token, and
  labelled `latency to first answer token` so the two are never compared by
  accident.
- **AA's context window is AA's own approximate figure**, labelled
  `(AA, approximate)`. The harness runtime value always wins when it is known:
  for this deployment's `qwen-token-plan-cn/qwen3.8-flash` the runtime reports
  **272,000** while AA's page gives a rounded figure (its prose says 260k, its
  spec table currently shows 256k) — so 272,000 is what is printed and AA's
  number is not.
- **Rank is always empty** on today's pages, so no rank line is printed (see
  above). Nothing else in the profile is withheld because of it — score, price,
  context, speed and latency all render normally.
- **The enrichment depends on the native tool's line format.** An unparseable
  native result is passed through untouched rather than guessed at, and the test
  suite asserts the original text survives byte-for-byte.

## Development

```bash
npm test              # node --test test/*.test.mjs
npm run test:mount    # bundle-wiring check (row id/name parity, README warning)
npm run test:pack     # npm-pack allowlist: NOTICE, docs and every lib module must ship
npm run sync:aa       # optional: write a local AA snapshot (needs an AA key)
```

The plugin itself has **no dependencies**: at runtime the harness supplies
`@deepseek-ai/schemastery` and `@earendil-works/pi-ai` from its own module graph,
and the profile's installer links them into the package directory (`pnpm` writes
a `node_modules` symlink there for exactly that reason). Two things follow for
local work:

- run the suite from a checkout that can resolve those packages. Point a
  `node_modules` symlink at a DSH install
  (`ln -s /path/to/dsh/node_modules node_modules`), or simply work inside an
  installed profile. Without it, the two suites that import the real config
  schema cannot load and `npm test` reports them as failed files.
- `pnpm` prints `missing peer @deepseek-ai/cordis` during install. That is
  informational, not a fault: this is the same declaration the other DSH plugins
  in this workspace ship, and the harness provides cordis to a mounted plugin at
  runtime rather than through the profile's dependency graph.

See `CONTEXT.md` for the glossary and `docs/adr/` for the design records.

## License and attribution

MIT — see `LICENSE`. Third-party data and services used at runtime are listed in
`NOTICE`; this plugin is an independent community project, not affiliated with
or endorsed by DeepSeek or by Artificial Analysis.

# Look Artificial Analysis up at runtime instead of bundling their data

The original plan was to generate a snapshot of Artificial Analysis's tracked
models (653 of them at the time) and ship it in this repository. Their Data
Platform Terms forbid embedding their data in a customer-facing product (§2.4)
and separately restrict using it for model or provider-selection guidance
(§2.5), while requiring attribution at every tier (§5.1); their API
documentation asks integrators to cache responses rather than redistribute them,
and their own tier table describes the free API as "internal use only; no
redistribution". We therefore ship **no Artificial Analysis data**: the profile
is looked up at runtime under an 8-second default hard deadline, shown only
inside the conversation, attributed on every render, and the optional local
snapshot (`bin/sync-aa.mjs` → `data/aa-snapshot.json`) is gitignored so it can
never be published.

**Considered Options**

- **Bundling a generated snapshot of all tracked models.** This was the original
  preference and the reason the plan changed: it is the fastest, most reliable
  path technically, and it is the one thing the licence plainly forbids in a
  product.
- **Depending on the user's API key.** Rejected: the free tier needs an account,
  and a plugin that renders nothing until the user registers somewhere else has
  failed its zero-configuration requirement. The key stays optional and only
  selects a faster path.
- **Scraping at install time.** Rejected: the same licensing problem as
  bundling, plus a network dependency in the install step, which would make
  installation fail for reasons that have nothing to do with the plugin.

**Consequences**

- Every number stays fresh and compliant, at the cost of a network round trip
  inside a tool call. That cost is bounded: the whole lookup lives inside
  `config.timeoutMs`, results are cached in memory (a six-hour floor on the
  keyed index, because the free tier is 100 requests / 24 h), failures are
  remembered briefly instead of retried, and no failure can do worse than leave
  the native result untouched.
- With no key the public model page is parsed (schema.org JSON-LD), so the
  plugin works with zero configuration; with a key it uses
  `/api/v2/language/models/free`, which is the replacement for the
  `/api/v2/data/llms/models` endpoint retiring on 2026-11-04.
- Attribution is not optional in the renderer: the credit line
  `Source: Artificial Analysis (artificialanalysis.ai)` and the specific source
  URL travel with the data every time it is shown, and the licence reasoning
  lives in `NOTICE` so a future contributor cannot "optimize" the network call
  away by committing a snapshot.

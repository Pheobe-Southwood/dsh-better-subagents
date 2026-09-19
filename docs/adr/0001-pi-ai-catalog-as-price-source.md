# Read the bundled pi-ai catalogue directly for prices

The harness LLM seam has no cost field at all — `LlmModelInfo` and
`LlmResolvedModelInfo` carry provider, id, name, description, modalities,
context window, max tokens and reasoning efforts, and a grep of the installed
`@deepseek-ai` packages finds no USD token rate anywhere (the only other
"price" surface, `LlmImageRequestPricing`, prices image occurrences in tokens,
not money). The pi-ai catalogue the harness already ships does carry
`cost { input, output, cacheRead, cacheWrite }` for every one of its 1,354 model
records, with at least one non-zero rate on 1,239 of them, so we read
`@earendil-works/pi-ai/providers/all` to price a delegation route. By design the
package declares **no dependency**: the specifier is resolved bare first (Node
resolves it from this file's real path, inside the profile's `node_modules`) and
otherwise by absolute path under `$DSH_HOME`, and the outcome is cached for the
life of the process.

**Considered Options**

- **A hand-maintained price table in this repository.** Rejected: it rots the
  day a provider changes a rate, and it would be a second source of truth next
  to the one the adapter actually bills from.
- **Asking the harness for prices.** Rejected: the field does not exist, and
  adding it is a harness change, not a plugin one.
- **Requiring users to configure prices.** Still supported as a per-route
  override (`config.profiles`), but rejected as the default: a plugin whose
  out-of-the-box answer to "what does this cost" is "ask your operator" has not
  solved the problem it exists for.

**Consequences**

- Prices are free, offline, and consistent with what the deployment's own
  adapter charges, because both sides read the same catalogue record.
- The cost is a dependency on an internal catalogue that is not a public API:
  hence the two-stage resolution, the strictly read-only access, and the
  graceful degradation — a route the catalogue cannot describe loses its price
  and keeps every other fact.
- Because the fallback path is derived from `DSH_HOME`, a hoisted
  `dsh plugin add` install and a `link:` checkout resolve the same file; a
  deployment that has neither simply reports "price unknown".

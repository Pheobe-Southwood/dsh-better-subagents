# dsh-better-subagents

The domain language of a DSH host plugin that appends authoritative model
profiles to the native `list_subagent_models` result. This file is a glossary
and nothing else: it records what this project's terms mean, not how anything is
built.

## Language

### Routing and authorization

**Delegation route**:
The exact `provider/model` pair a subagent could be delegated to — for example
`qwen-token-plan-cn/qwen3.8-flash`. A route is not a model: the same model id
under two providers is two delegation routes with their own prices, context
windows and authorization.
_Avoid_: model entry, endpoint, target

**Authorized route**:
A delegation route the calling Session is permitted to delegate to, as frozen in
that Session's `subagent/model-selection-policy` when it was created. A route in
the native listing that is not authorized is annotated and never looked up, and
unknown authorization is never treated as permission.
_Avoid_: allowed model, permitted model, valid route

**Provider** (⚠ overloaded):
In a delegation route, the model provider — the first half of `provider/model`,
such as `qwen-token-plan-cn`. In `ctx.subagents` the same word means the
subagent *transport* — `spawn` or `fork` — which is unrelated. This plugin deals
only with the model-provider sense.
_Avoid_: using "provider" for a subagent transport in this project's language

### Profiles and provenance

**Model profile**:
The set of facts this plugin appends about one delegation route: score, price,
context window, max output, speed, latency, reasoning levels, modalities and
prose guidance. A profile is advisory conversation text inside one tool result;
it is nothing the harness stores or enforces.
_Avoid_: model card, metadata, stats

**Provenance**:
The record of which source supplied each fact of a profile, and the URL that
source was read from. A fact without provenance is not rendered.
_Avoid_: source, origin, citation

**Native listing**:
The text `list_subagent_models` produces on its own, before this plugin appends
anything — route ids, display names, descriptions and reasoning levels. It is
the thing being enriched, and its exact line format is a dependency, not an
implementation detail.
_Avoid_: original output, raw output, bare listing

### Names and lookup

**Normalized model id**:
A local model id reduced to its comparable form: lowercased, provider prefix
dropped, `_` and whitespace folded to `-`, and a dot between a digit and what
follows turned into `-` — so `qwen3.8-flash` and `Qwen3.8_Flash` both normalize
to `qwen3-8-flash`. Normalization is deliberately narrow: `gpt-oss-120b` is not
rewritten into a name no catalogue carries.
_Avoid_: canonical id, cleaned id, slug

**AA slug**:
The identifier Artificial Analysis uses in its model page URLs, such as
`qwen3-8-flash-next`. It is a third naming system alongside the provider and the
model id, and it does not always match either.
_Avoid_: AA model id, AA name, AA key

**Alias**:
A deliberate mapping from a local model id to the AA slug that names the same
model, because no name transformation can derive one from the other:
`qwen3.8-flash` is published by Artificial Analysis as `qwen3-8-flash-next`, and
without the alias the lookup finds nothing. Aliases are this project's own name
mappings, never Artificial Analysis data.
_Avoid_: rename, translation, override

### Pricing and measurement

**Subscription route**:
A delegation route whose catalogue rate is zero on every dimension because the
deployment pays for it by subscription rather than per token — this
deployment's `qwen-token-plan-cn/qwen3.8-flash` is one. It is rendered
`subscription route (catalogue rate 0)`, and never as `$0.00` or "free".
_Avoid_: free route, zero-cost model, included model

**"Not measured"**:
Artificial Analysis's convention for a metric it did not publish: the value is
absent, which is **not** the same as a measured `0`. A profile omits a
not-measured fact entirely, and a genuine zero stays zero.
_Avoid_: unknown, missing, N/A, zero

**Artificial Analysis Intelligence Index**:
A third-party composite score for a model's reasoning ability, measured by
Artificial Analysis and published under a version (for example `v4.3`) because
its composition changes over time. It is their metric, not this project's, and a
score is only meaningful next to its version.
_Avoid_: AA score, intelligence score, benchmark rank

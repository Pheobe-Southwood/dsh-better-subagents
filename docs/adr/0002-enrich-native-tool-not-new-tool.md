# Enrich the native tool instead of shipping a new one

`tools/post-execute` is a waterfall a plugin can use to replace a finished tool
result's `content`, and a listener registered on the host root context is
untagged, so it observes every agent's calls. We register exactly one listener,
match `list_subagent_models` by name, and append our profile block to that
result — the Agent keeps calling the native tool, and the text it reads back
grows the facts it was missing.

**Considered Options**

- **Registering a second tool that returns the enriched list.** Rejected: the
  Agent would have to know to call it instead of the native one, and the native
  output would stay bare for every caller that did not, which is the opposite of
  the goal.
- **Shadowing the native tool with a scoped re-registration.** Rejected: it
  would mean re-implementing the owner's route policy (which routes exist, which
  the Session may use) inside this plugin, and it would silently break the day
  that policy changes.

**Consequences**

- The Agent's workflow does not change and no policy logic is duplicated: the
  native tool still decides what a Session may see, and we only add facts about
  what it already listed.
- The price of that decision is a dependency on the native tool's exact text
  format. An unparseable result is passed through untouched rather than guessed
  at, and the test suite asserts the original text survives byte-for-byte.
- The enrichment is advisory by construction: a tool's own `finalizeContent`
  runs after this waterfall (today's `list_subagent_models` declares none) and
  caller cancellation can still replace the outcome. Nothing here resists that,
  and nothing should.
- A throwing `tools/post-execute` listener would turn a good tool result into an
  `isError` result, so the handler is written to never throw — every skip,
  failure, and unknown-authorization case returns the untouched native decision.

/**
 * Manual live probe for dsh-better-subagents.
 *
 * This script performs REAL network requests to artificialanalysis.ai. It is a
 * diagnostic for humans, not a test: the file name deliberately does not match
 * the `test/*.test.mjs` glob, so `npm test` (`node --test test/*.test.mjs`)
 * never picks it up and CI never spends an Artificial Analysis request.
 *
 * Usage:
 *
 *   node test/live-probe.mjs [provider/model]
 *       One live lookup against Artificial Analysis. Defaults to
 *       qwen-token-plan-cn/qwen3.8-flash.
 *
 *   node test/live-probe.mjs --offline [provider/model]
 *       No network at all (`timeoutMs: 0`): snapshot + hand-written profiles
 *       only. With no synced snapshot this reports the honest `offline` miss.
 *
 * What it exercises — the real repository code end-to-end, no harness needed:
 *
 *   1. `lib/index-config.js` resolves the configuration through the real
 *      Schemastery schema (real defaults, or `timeoutMs: 0` for `--offline`).
 *   2. `lib/post-execute.js` `createEnricher()` handles a synthetic
 *      `list_subagent_models` detail call. The ONLY injected seam is
 *      `authorizedRoutes` — a bare process has no Session whose frozen
 *      delegation policy could be read. Everything else (native parser,
 *      pi-ai price catalogue, Artificial Analysis client, merge, render) is
 *      the real implementation.
 *   3. The lookup summary comes from one direct `createAaClient().lookup()`
 *      call, which shares the client's module-level cache with step 2 and
 *      therefore costs no extra network request.
 *
 * Without a live harness there is no `llm` service, so runtime adapter facts
 * (context window, max output, reasoning efforts) are absent and the
 * catalogue/AA figures stand in — exactly the degradation an unmounted
 * runtime produces.
 *
 * Exit codes: 0 lookup succeeded · 1 lookup failed · 2 usage error.
 * No credential value is ever read or printed.
 */

const DEFAULT_ROUTE = 'qwen-token-plan-cn/qwen3.8-flash'
const NATIVE_TOOL_NAME = 'list_subagent_models'

const usage = () => {
  console.error('usage: node test/live-probe.mjs [--offline] [provider/model]')
}

/** Parse `--offline` plus at most one `provider/model` positional. */
function parseArgs(argv) {
  let offline = false
  let route = DEFAULT_ROUTE
  for (const arg of argv) {
    if (arg === '--offline') {
      offline = true
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`)
      usage()
      process.exit(2)
    } else {
      route = arg
    }
  }
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) {
    console.error(`route must look like provider/model, got: ${route}`)
    usage()
    process.exit(2)
  }
  return { offline, provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

const { offline, provider, model } = parseArgs(process.argv.slice(2))

const { Config } = await import('../lib/index-config.js')
const { createEnricher } = await import('../lib/post-execute.js')
const { createAaClient } = await import('../lib/aa/client.js')

const config = offline === true ? Config({ timeoutMs: 0 }) : Config({})

// Minimal fake context: no `llm`, no `web`, no `credentials` service — the
// shape a bare process really has. Logger goes to stderr so stdout carries
// only the probe report.
const ctx = {
  get() {
    return undefined
  },
  logger: {
    info() {},
    warn() {},
    error(message) {
      console.error(message)
    },
  },
}

// The one faked seam: a bare process has no Session to read a delegation
// policy from, so the probe states the route as authorized directly.
const deps = {
  authorizedRoutes: async () => [{ provider, model }],
}

const enricher = createEnricher(ctx, config, deps)
const client = createAaClient({ config, ctx })

// The native tool's detail line, shaped exactly like the real output
// (`provider/model — Name`); the enrichment appends after whatever the
// native tool wrote.
const nativeText = `${provider}/${model} — ${model}`
const exec = { name: NATIVE_TOOL_NAME, arguments: { provider, model } }
const result = { isError: false, content: [{ type: 'text', text: nativeText }] }

const startedAt = Date.now()
const decision = await enricher(exec, result)
const enrichMs = Date.now() - startedAt

if (decision?.kind !== 'accept' || !Array.isArray(decision.content)) {
  console.error(`probe failed: enricher returned ${JSON.stringify(decision ?? null)} instead of an accept decision`)
  process.exit(1)
}

const lookupStartedAt = Date.now()
const answer = await client.lookup(provider, model)
const lookupMs = Date.now() - lookupStartedAt

const textOf = (content) =>
  content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : `[non-text block: ${block?.type ?? 'unknown'}]`))
    .join('\n')

console.log('better-subagents live probe')
console.log(`  route:   ${provider}/${model}`)
console.log(`  budget:  ${offline ? 'offline (timeoutMs: 0 — no network)' : `live (timeoutMs: ${config.timeoutMs} ms)`}`)
console.log('  note:    no harness session here, so the route authorization is injected')
console.log('           and runtime adapter facts (context window, reasoning) are absent;')
console.log('           catalogue/AA figures stand in, exactly as on an unmounted runtime.')
console.log()
console.log(
  `  lookup:  ${answer?.ok === true ? 'ok' : 'FAILED'}`
    + (answer?.via !== undefined ? ` via=${answer.via}` : '')
    + (answer?.data?.slug !== undefined ? ` slug=${answer.data.slug}` : '')
    + (answer?.data?.sourceOrigin !== undefined ? ` sourceOrigin=${answer.data.sourceOrigin}` : ''),
)
if (answer?.ok === true) {
  console.log(`           sourceUrl=${answer.sourceUrl ?? 'none'}`)
  console.log(`           fetchedAt=${answer.fetchedAt ?? 'none'}`)
}
console.log(`           enricher=${enrichMs} ms, direct lookup=${lookupMs} ms (shared cache)`)
console.log()
console.log('--- tool result as a model would see it ---')
console.log(textOf(decision.content))
console.log('--- end of tool result ---')

if (answer?.ok !== true) {
  const detail = typeof answer?.detail === 'string' && answer.detail.length > 0 ? ` — ${answer.detail}` : ''
  console.log()
  console.error(`lookup failed: ${answer?.reason ?? 'unknown reason'}${detail}`)
  process.exit(1)
}

console.log()
console.log(`elapsed: ${Date.now() - startedAt} ms total`)

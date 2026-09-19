/**
 * `npm run test:pack` — the npm-pack gate: what a publish would actually upload.
 *
 * Two questions, both answered from the real `npm pack --dry-run --json` report
 * rather than from `package.json`'s intent:
 *
 *   1. **Allowlist** — is everything a release must ship really inside the
 *      tarball? The named artifacts are listed explicitly, `lib/**\/*.js` is
 *      derived by walking the directory (so a new module cannot be silently
 *      dropped by a `files` mistake), and every `docs/adr/000*.md` on disk must
 *      be published (there must be at least one).
 *   2. **Denylist** — does anything private get in? No `test/`, no `.github/`,
 *      no `node_modules/`, no lockfile, no lint config, no nested `.tgz`, no
 *      path naming a credential, and above all no `data/aa-snapshot.json`:
 *      `files` ships the whole `data` directory, so npm would happily publish a
 *      snapshot a developer synced for local use, and Artificial Analysis's Data
 *      Platform Terms forbid redistributing it. The `.gitignore` entry is what
 *      keeps it out of git; this gate is what keeps it out of a tarball.
 *
 * The invocation mirrors `dsh-better-workspaces/test/package.mjs` exactly,
 * including the `process.env.npm_execpath` branch that makes it work under
 * `npm run test:pack` (where `npm` is not necessarily on PATH as a binary this
 * process can spawn). Every problem found is reported at once, each naming the
 * artifact it is about, and a run that finds none prints one line:
 * `PACKAGE: ALL PASS (<n> files, <size> bytes)`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'

/** Repository root; every path below is resolved from the file, not the cwd. */
const root = new URL('../', import.meta.url)

/** Directory holding the released ADRs. */
const ADR_DIR = 'docs/adr/'

/** The numbering convention that marks an ADR as released documentation. */
const ADR_GLOB = '000*.md'
const ADR_RE = /^000.*\.md$/

/**
 * Artifacts a release must contain whatever else is on disk. Spelled out rather
 * than derived, because "the entry point moved" is precisely the mistake this
 * gate exists to catch: a derived list would simply agree with the new layout.
 */
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/post-execute.js',
  'lib/catalog.js',
  'lib/aa/client.js',
  'lib/aa/parse.js',
  'bin/sync-aa.mjs',
  'data/aliases.json',
]

/** Local-only data that must never be redistributed in a tarball. */
const LOCAL_ONLY = 'data/aa-snapshot.json'

/** Development tooling that has no business in a published package. */
const LINT_CONFIG_RE =
  /^(?:eslint\.config\.(?:js|cjs|mjs|ts)|\.eslintrc(?:\.(?:js|cjs|json|yml|yaml))?|\.eslintignore)$/

/** Substrings in a path that would mean a credential file got packaged. */
const SECRET_PATH_HINTS = ['credentials', '.env', 'AA_API_KEY']

/**
 * Whether a repo-relative path exists on disk.
 *
 * @param {string} relativePath Path relative to the repository root.
 * @returns {Promise<boolean>} True when something is there.
 */
async function exists(relativePath) {
  try {
    await stat(new URL(relativePath, root))
    return true
  } catch {
    return false
  }
}

/**
 * Every file under a repo-relative directory, as repo-relative paths.
 *
 * Directories only: symlinks are not followed (the root `node_modules` is a
 * symlink into the DSH install, and nothing behind it is this package's source).
 *
 * @param {string} directory Directory relative to the repository root, with a trailing slash.
 * @returns {Promise<string[]>} Contained file paths, unsorted.
 */
async function walk(directory) {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    const path = `${directory}${entry.name}`
    if (entry.isDirectory()) paths.push(...(await walk(`${path}/`)))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

/**
 * Why this path must not be published, if it must not be.
 *
 * @param {string} path Tarball-relative path from the pack report.
 * @returns {string[]} Human-readable reasons; empty when the path is fine.
 */
function denyReasons(path) {
  const reasons = []
  const base = path.split('/').pop() ?? path
  if (path.startsWith('test/')) reasons.push('test fixture')
  if (path.startsWith('.github/')) reasons.push('CI file')
  if (path.startsWith('node_modules/')) reasons.push('dependency')
  if (path === 'package-lock.json') reasons.push('lockfile')
  if (LINT_CONFIG_RE.test(base)) reasons.push('lint config')
  if (path.endsWith('.tgz')) reasons.push('nested tarball')
  if (path === LOCAL_ONLY) reasons.push('Artificial Analysis snapshot, which must never be redistributed')
  for (const hint of SECRET_PATH_HINTS) {
    if (path.includes(hint)) reasons.push(`path mentions "${hint}"`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// manifest wiring
// ---------------------------------------------------------------------------

const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

assert.equal(manifest.main, 'lib/index.js', 'the Cordis entry point is `lib/index.js`')
assert.equal(manifest.exports?.['.'], './lib/index.js', 'the "." export resolves to the entry point')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'the dsh bundle patch is shipped and wired')
assert.equal(manifest.type, 'module', 'the package is ESM')

// Zero runtime dependencies: everything the plugin needs is either Node, a
// harness peer, or resolved through the Cordis context. A dependency here would
// be a second install tree in every profile that mounts this package.
const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
assert.deepEqual(runtimeDependencies, [], 'this package must declare no runtime dependencies')

// Host-plane plugin: it enriches a tool result on the host and registers no
// browser UI, so a client half would be dead weight in the bundle patch.
assert.equal(manifest.dsh?.client, undefined, 'this is a host-plane plugin and declares no dsh.client half')

// ---------------------------------------------------------------------------
// what must be published
// ---------------------------------------------------------------------------

// Derived, so a module added later is required to ship even if nobody remembers
// to add it to the list above.
const libModules = (await walk('lib/')).filter((path) => path.endsWith('.js')).sort()
assert.ok(libModules.includes('lib/index.js'), 'the lib/ walk found the entry point, so it saw the real tree')

// Globbed rather than named: the ADR set grows, and a new one must be published.
let adrFiles = []
try {
  adrFiles = (await readdir(new URL(ADR_DIR, root))).filter((name) => ADR_RE.test(name)).sort()
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const required = [...new Set([...REQUIRED, ...libModules, ...adrFiles.map((name) => `${ADR_DIR}${name}`)])]

// ---------------------------------------------------------------------------
// the pack report
// ---------------------------------------------------------------------------

const npmCommand = process.env.npm_execpath ? process.execPath : 'npm'
const npmArgs = process.env.npm_execpath
  ? [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts']
  : ['pack', '--dry-run', '--json', '--ignore-scripts']
const packed = spawnSync(npmCommand, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, npm_config_loglevel: 'error' },
})
assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr || packed.stdout}`)
let report
try {
  report = JSON.parse(packed.stdout)
} catch (error) {
  throw new Error(`npm pack did not return JSON: ${packed.stdout.slice(0, 500)}`, { cause: error })
}
assert.equal(report.length, 1, 'npm pack reports exactly one package')
assert.ok(Array.isArray(report[0]?.files), `the pack report carries a file list (got ${typeof report[0]?.files})`)

const files = new Set(report[0].files.map((entry) => entry.path))
const problems = []

// Allowlist: everything a release must ship, named one by one.
for (const path of required) {
  if (files.has(path)) continue
  const onDisk = await exists(path)
  problems.push(`missing from the tarball: ${path}${onDisk ? '' : ' (and absent on disk)'}`)
}
if (adrFiles.length === 0) {
  problems.push(
    `no ADR is published: ${ADR_DIR} holds no ${ADR_GLOB} file` +
      (await exists(ADR_DIR) ? '' : ` (the ${ADR_DIR} directory does not exist)`),
  )
}

// Denylist: nothing private, whatever `files` happens to match.
for (const path of files) {
  for (const reason of denyReasons(path)) problems.push(`denied artifact in the tarball (${reason}): ${path}`)
}
if (await exists(LOCAL_ONLY)) {
  problems.push(
    `${LOCAL_ONLY} exists on disk and \`files\` ships the whole data directory: ` +
      'Artificial Analysis data must never be redistributed, so delete it (it is git-ignored) before packing',
  )
}

assert.ok(problems.length === 0, `npm pack gate failed:\n${problems.map((line) => `  - ${line}`).join('\n')}`)

assert.ok(
  report[0].size > 0 && report[0].unpackedSize > report[0].size,
  `pack report has implausible sizes (size=${report[0].size}, unpackedSize=${report[0].unpackedSize})`,
)

console.log(`PACKAGE: ALL PASS (${files.size} files, ${report[0].size} bytes)`)

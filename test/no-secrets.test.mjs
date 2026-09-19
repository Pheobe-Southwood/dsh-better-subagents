/**
 * `test/no-secrets.test.mjs` — the secret-hygiene gate.
 *
 * This package is the only place in the bundle that touches an API credential,
 * so the release asks four questions of the shipped source (`lib/`, `bin/` and
 * every other text file in the tree, minus `node_modules/`, `.git/` and `test/`
 * itself, which is tooling rather than shipped code):
 *
 *   1. **Can a credential be embedded?** No literal may be assigned to a name
 *      that conventionally holds a secret, the `x-api-key` request header must
 *      always carry a *resolved* value (never a literal), and no `sk-`/`AA-`
 *      style key prefix may appear inside a quoted literal. Only obvious
 *      stand-ins pass: an empty string, `<your key>`, or a credential *name*
 *      such as `AA_API_KEY` — a name is not a value. The one identifier that is
 *      *called* a key without holding one is listed, reasoned and shape-guarded
 *      in {@link NON_CREDENTIAL_KEY_BINDINGS} rather than pattern-matched away.
 *   2. **Can a credential be logged?** No `console.*` call may exist in `lib/`
 *      or `bin/`, and no value passed to any print sink may be an identifier
 *      that holds a credential. `bin/sync-aa.mjs` is a CLI, so it may print
 *      progress; what it prints must stay paths, counts, status text and the
 *      credential *name*.
 *   3. **Can a credential be written?** `process.env.X = …` must not appear
 *      anywhere: the environment is read (`process.env[credentialName]`), never
 *      written, because a written key would leak into every child process.
 *   4. **Is `AA_API_KEY` a name or a value?** Wherever the default credential
 *      name appears in `lib/`, it must be bound to a name-carrying identifier
 *      (`DEFAULT_CREDENTIAL_REF`, `credentialRef`), be addressed as a name
 *      (`process.env.AA_API_KEY`), or sit in a doc comment — never be the
 *      fallback value handed to a missing credential.
 *
 * The checks read *code*, not prose. {@link blankLiterals} removes comments,
 * string bodies, template raw text and regular-expression bodies while keeping
 * every byte offset (so line numbers stay exact) and keeping the `${…}`
 * interpolations inside a template literal, because that is the code that runs.
 * That is what keeps a JSDoc line mentioning `AA_API_KEY`, or the word `key`
 * inside a message string, from being reported as a leak.
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import test from 'node:test'

/** Repository root; every path below is resolved from the file, not the cwd. */
const ROOT = new URL('../', import.meta.url)

/** Not this package's source: dependencies, VCS metadata, and the gate itself. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'test'])

/** Extensions worth scanning as text. */
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.yml', '.yaml', '.md', '.txt', '.toml', '.sh',
])

/** Extensionless files that are still source or documentation. */
const TEXT_NAMES_RE = /^(?:[A-Z][A-Z0-9_-]*|\.(?:gitignore|npmignore|npmrc|gitattributes|editorconfig))$/

/** Anything larger is data, not source; nothing this package ships is that big. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// source scanning
// ---------------------------------------------------------------------------

/** Keywords after which a `/` opens a regular expression rather than divides. */
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
])

/** Characters after which a `/` opens a regular expression rather than divides. */
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%^~<>'

/**
 * Blank out everything in `source` that is not executable code, preserving each
 * character's offset — and therefore every line number — exactly.
 *
 * Comments, string bodies, the raw text of template literals and the body of a
 * regular-expression literal become spaces; `${…}` interpolations inside a
 * template literal are *kept*, since that is the code that runs.
 *
 * Regular-expression literals are recognised the usual way, by what precedes the
 * `/`: an operator or a keyword opens one, an identifier or a `)` divides. A
 * `/` that turns out not to be a regex (the scan reaches the end of the line)
 * is treated as division after all, so a heuristic miss cannot swallow code.
 *
 * @param {string} source File text.
 * @returns {{ code: string, noComments: string }} `code` has comments, literal
 *   bodies and regex bodies blanked; `noComments` has only comments blanked.
 */
function blankLiterals(source) {
  const code = [...source]
  const noComments = [...source]
  const frames = []
  let mode = 'code'
  let braces = 0
  let inCharacterClass = false
  let index = 0

  /** Blank a character in the code view only (comments keep it in `noComments`). */
  const blankCode = (at) => {
    if (code[at] !== '\n') code[at] = ' '
  }

  /** Blank a character in both views (it is a comment). */
  const blankBoth = (at) => {
    if (code[at] === '\n') return
    code[at] = ' '
    noComments[at] = ' '
  }

  /** Whether the `/` at `at` opens a regular expression. */
  const regexCanStart = (at) => {
    let back = at - 1
    while (back >= 0 && /\s/.test(code[back])) back -= 1
    if (back < 0) return true
    const previous = code[back]
    if (/[\w$]/.test(previous)) {
      let start = back
      while (start > 0 && /[\w$]/.test(code[start - 1])) start -= 1
      return REGEX_PREFIX_KEYWORDS.has(code.slice(start, back + 1).join(''))
    }
    return REGEX_PREFIX_CHARS.includes(previous)
  }

  /** Leave an interpolation and return to the frame it was opened from. */
  const popFrame = () => {
    const frame = frames.pop()
    mode = frame === undefined ? 'code' : frame.mode
    braces = frame === undefined ? braces : frame.braces
  }

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]

    if (mode === 'line') {
      if (character === '\n') mode = 'code'
      else blankBoth(index)
      index += 1
      continue
    }

    if (mode === 'block') {
      if (character === '*' && next === '/') {
        blankBoth(index)
        blankBoth(index + 1)
        mode = 'code'
        index += 2
        continue
      }
      blankBoth(index)
      index += 1
      continue
    }

    if (mode === 'single' || mode === 'double') {
      if (character === '\\') {
        blankCode(index)
        blankCode(index + 1)
        index += 2
        continue
      }
      if (character === (mode === 'single' ? "'" : '"')) {
        mode = 'code'
        index += 1
        continue
      }
      blankCode(index)
      index += 1
      continue
    }

    if (mode === 'regex') {
      if (character === '\n') {
        // A regex literal never spans lines, so this `/` divided after all.
        mode = 'code'
        continue
      }
      if (character === '\\') {
        blankCode(index)
        blankCode(index + 1)
        index += 2
        continue
      }
      if (character === '[') inCharacterClass = true
      if (character === ']') inCharacterClass = false
      if (character === '/' && !inCharacterClass) {
        mode = 'code'
        index += 1
        continue
      }
      blankCode(index)
      index += 1
      continue
    }

    if (mode === 'template') {
      if (character === '\\') {
        blankCode(index)
        blankCode(index + 1)
        index += 2
        continue
      }
      if (character === '`') {
        popFrame()
        index += 1
        continue
      }
      if (character === '$' && next === '{') {
        frames.push({ mode, braces })
        mode = 'code'
        braces = 0
        index += 2
        continue
      }
      blankCode(index)
      index += 1
      continue
    }

    // mode === 'code'
    if (character === '/' && next === '/') {
      blankBoth(index)
      blankBoth(index + 1)
      mode = 'line'
      index += 2
      continue
    }
    if (character === '/' && next === '*') {
      blankBoth(index)
      blankBoth(index + 1)
      mode = 'block'
      index += 2
      continue
    }
    if (character === '/' && regexCanStart(index)) {
      mode = 'regex'
      inCharacterClass = false
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      mode = character === '"' ? 'double' : 'single'
      index += 1
      continue
    }
    if (character === '`') {
      frames.push({ mode, braces })
      mode = 'template'
      braces = 0
      index += 1
      continue
    }
    if (character === '}' && braces === 0 && frames[frames.length - 1]?.mode === 'template') {
      popFrame()
      index += 1
      continue
    }
    if (character === '{') braces += 1
    else if (character === '}') braces -= 1
    index += 1
  }

  return { code: code.join(''), noComments: noComments.join('') }
}

/**
 * Whether a file name looks like text this gate should read.
 *
 * @param {string} name Base name.
 * @returns {boolean} True when the file is source or documentation.
 */
function isTextName(name) {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : ''
  return TEXT_EXTENSIONS.has(extension) || TEXT_NAMES_RE.test(name)
}

/**
 * Read every text file of the repository, minus dependencies, VCS metadata and
 * the test directory itself.
 *
 * @param {string} directory Directory relative to the root, with a trailing slash.
 * @returns {Promise<{ path: string, text: string }[]>} Files with their text.
 */
async function collectSourceFiles(directory = '') {
  const entries = await readdir(directory === '' ? ROOT : new URL(directory, ROOT), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      files.push(...(await collectSourceFiles(`${directory}${entry.name}/`)))
      continue
    }
    // Symlinks are not followed: the root `node_modules` is one, and nothing
    // behind it is this package's source.
    if (!entry.isFile() || !isTextName(entry.name)) continue
    const path = `${directory}${entry.name}`
    const info = await stat(new URL(path, ROOT))
    if (info.size > MAX_TEXT_BYTES) continue
    const text = await readFile(new URL(path, ROOT), 'utf8')
    if (text.includes('\u0000')) continue
    files.push({ path, text })
  }
  return files
}

/**
 * The scanned tree, read once: every check below is a pure function of it.
 *
 * @type {{ path: string, text: string, code: string, noComments: string, lines: string[] }[]}
 */
const FILES = (await collectSourceFiles()).map((file) => {
  const { code, noComments } = blankLiterals(file.text)
  return { ...file, code, noComments, lines: file.text.split('\n') }
}).sort((left, right) => left.path.localeCompare(right.path))

/**
 * Look one file up by path.
 *
 * @param {string} path Repo-relative path.
 * @returns {object} The analysed file.
 */
function fileOf(path) {
  const file = FILES.find((candidate) => candidate.path === path)
  assert.ok(file !== undefined, `${path} is part of the shipped source and must be scanned`)
  return file
}

/**
 * 1-based line number of an offset.
 *
 * @param {string} text File text.
 * @param {number} index Character offset.
 * @returns {number} Line number.
 */
function lineOf(text, index) {
  let line = 1
  for (let at = 0; at < index && at < text.length; at += 1) {
    if (text[at] === '\n') line += 1
  }
  return line
}

/**
 * A finding, rendered the way a failure message needs it: file, line, text.
 *
 * @param {object} file Analysed file.
 * @param {number} index Offset of the offending text.
 * @param {string} detail What is wrong with it.
 * @returns {{ where: string, detail: string }} Finding.
 */
function finding(file, index, detail) {
  const line = lineOf(file.text, index)
  const excerpt = (file.lines[line - 1] ?? '').trim()
  return { where: `${file.path}:${line}`, detail: `${detail}\n      ${excerpt}` }
}

/**
 * Render findings as one actionable, multi-line assertion message.
 *
 * @param {string} headline What the check proves.
 * @param {{ where: string, detail: string }[]} findings Findings to report.
 * @returns {string} Message.
 */
function report(headline, findings) {
  return [`${headline} (${findings.length} finding(s))`, ...findings.map((entry) => `  - ${entry.where}: ${entry.detail}`)].join('\n')
}

// ---------------------------------------------------------------------------
// shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Identifier endings that conventionally hold a secret *value*. A suffix of an
 * identifier, not a substring: `apiKey`, `AA_API_KEY`, `accessToken` and
 * `client_secret` qualify, while `tokensPerSecond` (a count) and `keyName` (a
 * name) do not.
 */
const SECRET_IDENTIFIER_SUFFIXES = [
  'apikey', 'api_key', 'accesskey', 'access_key', 'secretkey', 'secret_key',
  'privatekey', 'private_key', 'key', 'token', 'secret', 'password', 'passwd',
  'passphrase', 'credential', 'credentials',
]

/**
 * Whether an identifier conventionally holds a credential value.
 *
 * The boundary matters: `monkey` ends with `key` but is not a camelCase suffix,
 * and `keyName`/`credentialRef` are *names*, which this gate deliberately treats
 * as safe — a name is not a secret.
 *
 * @param {string} identifier Identifier as written.
 * @returns {boolean} True when the identifier holds a credential value.
 */
function holdsCredentialValue(identifier) {
  const name = identifier.toLowerCase()
  for (const suffix of SECRET_IDENTIFIER_SUFFIXES) {
    if (!name.endsWith(suffix)) continue
    const at = name.length - suffix.length
    if (at === 0) return true
    const previous = identifier[at - 1]
    if (previous === '_' || previous === '$') return true
    if (suffix.includes('_')) continue
    const first = identifier[at]
    if (first !== first.toLowerCase()) return true
  }
  return false
}

/**
 * Whether a literal is an obvious stand-in rather than a key.
 *
 * `AA_API_KEY` is allowed on purpose: it is the *name* of the credential, which
 * is exactly what the source is supposed to contain. So is an empty string, a
 * `<placeholder>`, `xxxxxxxx`, or anything spelling out placeholder/example.
 *
 * @param {string} value Literal text without quotes.
 * @returns {boolean} True when the literal cannot be a credential.
 */
function isPlaceholder(value) {
  if (value.trim() === '') return true
  if (/^<[^>]*>$/.test(value)) return true
  if (/^[.…]+$/.test(value)) return true
  if (/^[x*]{3,}$/i.test(value)) return true
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return true
  if (/(?:^|[-_ ])(?:placeholder|example|changeme|redacted|dummy|fake|sample|todo|here)(?:$|[-_ ])/i.test(value)) return true
  return false
}

/** Shortest literal that is treated as a possible key rather than as config noise. */
const MIN_SECRET_LITERAL_LENGTH = 4

/**
 * Bindings whose name looks like a credential but whose value is known not to be
 * one. Each entry is a reviewed decision, not a pattern escape hatch: the
 * identifier names something this package merely *calls* a key, and `value`
 * pins the shape the literal must still have for the waiver to apply — so a
 * `POLICY_KEY` that suddenly held opaque key material would be reported.
 *
 * @type {Map<string, { reason: string, value: RegExp }>}
 */
const NON_CREDENTIAL_KEY_BINDINGS = new Map([
  [
    'POLICY_KEY',
    {
      reason: 'names the durable Session projection key (a camelCase projection name), not key material',
      value: /^[a-z][A-Za-z0-9]*$/,
    },
  ],
])

/**
 * Calls whose arguments are printed somewhere. `log` is the CLI helper in
 * `bin/sync-aa.mjs` (it writes to stderr), `debug`/`report` are the plugin's
 * own log paths, and the member forms cover `console.*`, `process.stderr.write`
 * and `ctx.logger.info` alike.
 */
const PRINT_SINK_RE = new RegExp(
  [
    String.raw`console\s*\.\s*(?:log|info|warn|error|debug|trace|dir|table)`,
    String.raw`[\w$]+\s*\??\s*\.\s*(?:write|writeSync|print|println|log|info|warn|error|debug|trace)`,
    String.raw`(?<![\w$.])(?:log|report|print|println|info|warn|error|debug)`,
  ].join('|'),
  'g',
)

/** `console.*` calls, which this package does not use anywhere in `lib/` or `bin/`. */
const CONSOLE_CALL_RE = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace|dir|table)\s*\(/g

/** `process.env.X = …` and `process.env['X'] = …`, in every compound spelling. */
const ENV_WRITE_RE =
  /process\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*"|\$\{[^}]*\})\s*\])\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\*\*=|&&=|\|\|=|\?\?=)/g

// ---------------------------------------------------------------------------
// check 1 — a credential cannot be embedded
// ---------------------------------------------------------------------------

const API_KEY_HEADER_ASSIGNMENT_RES = [
  // { 'x-api-key': 'literal' }
  /x-api-key['"]?\s*:\s*(['"])([^'"\n]*)\1/gi,
  // headers['x-api-key'] = 'literal'
  /x-api-key['"]?\s*\]\s*[:=]\s*(['"])([^'"\n]*)\1/gi,
  // headers.set('x-api-key', 'literal')
  /x-api-key['"]?\s*,\s*(['"])([^'"\n]*)\1/gi,
]

/** A profile-style assignment of a quoted literal to a secret-looking name. */
const SECRET_ASSIGNMENT_RE = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*[:=]\s*(['"])([^'"\n]*)\2/g

/** Quoted literals that carry an embedded key prefix. */
const KEY_PREFIX_RE = /(['"`])((?:sk|sk-ant|sk-proj|sk-live|sk-test|AA|AKIA|ghp|github_pat|xox[bpoa])[-_][A-Za-z0-9_-]{8,})\1/g

test('no source file embeds a credential literal', (t) => {
  const findings = []
  const waived = []

  for (const file of FILES) {
    for (const pattern of API_KEY_HEADER_ASSIGNMENT_RES) {
      for (const match of file.text.matchAll(pattern)) {
        if (isPlaceholder(match[2])) continue
        findings.push(finding(file, match.index, `the x-api-key header is set from the literal "${match[2]}" instead of a resolved value`))
      }
    }

    for (const match of file.text.matchAll(SECRET_ASSIGNMENT_RE)) {
      const [, identifier, , value] = match
      if (!holdsCredentialValue(identifier)) continue
      if (isPlaceholder(value) || value.length <= MIN_SECRET_LITERAL_LENGTH) continue
      if (value.includes('${')) continue
      const waiver = NON_CREDENTIAL_KEY_BINDINGS.get(identifier)
      if (waiver !== undefined && waiver.value.test(value)) {
        waived.push(`${file.path}:${lineOf(file.text, match.index)} ${identifier} — ${waiver.reason}`)
        continue
      }
      findings.push(finding(file, match.index, `"${identifier}" is assigned the literal "${value}"; read it from ctx.credentials or process.env instead`))
    }

    for (const match of file.text.matchAll(KEY_PREFIX_RE)) {
      findings.push(finding(file, match.index, `an embedded key prefix ("${match[2].slice(0, 12)}…") must never be committed`))
    }
  }

  for (const entry of waived) t.diagnostic(`no-secrets: waived (documented non-credential key) ${entry}`)
  assert.deepEqual(findings, [], report('a credential literal is embedded in the source', findings))
})

test('the x-api-key header always carries a resolved credential', () => {
  // The shape, not the intent: both request paths must build the header from the
  // `key` that `resolveCredential()` produced, so the gate fails if a future
  // change inlines a literal there.
  const client = fileOf('lib/aa/client.js')
  assert.match(client.text, /['"]x-api-key['"]\s*:\s*key\b/, "lib/aa/client.js must set 'x-api-key' from the resolved `key`")
  assert.match(client.text, /credentials\.resolve\(ref\)/, 'the key must be resolved through ctx.credentials')
  assert.match(client.text, /process\.env\[credentialName\]/, 'the fallback must read the environment by credential NAME')

  const cli = fileOf('bin/sync-aa.mjs')
  assert.match(cli.text, /['"]x-api-key['"]\s*:\s*key\b/, "bin/sync-aa.mjs must set 'x-api-key' from the resolved `key`")
  assert.match(cli.text, /process\.env\[name\]/, 'the CLI must read the key from the environment by name')
})

// ---------------------------------------------------------------------------
// check 2 — a credential cannot be logged
// ---------------------------------------------------------------------------

/**
 * Text of the arguments of the call whose `(` sits at `open`.
 *
 * The scan runs over blanked code, so a parenthesis inside a string, comment or
 * regex cannot unbalance it.
 *
 * @param {string} code Blanked code view.
 * @param {number} open Offset of the `(`.
 * @returns {{ text: string, start: number }} Argument text and its offset.
 */
function argumentText(code, open) {
  let depth = 0
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === '(') depth += 1
    else if (code[at] === ')') {
      depth -= 1
      if (depth === 0) return { text: code.slice(open + 1, at), start: open + 1 }
    }
  }
  return { text: code.slice(open + 1), start: open + 1 }
}

test('no credential can be logged from lib/ or bin/', () => {
  const shipped = FILES.filter((file) => file.path.startsWith('lib/') || file.path.startsWith('bin/'))
  const findings = []
  const sinks = new Set()

  for (const file of shipped) {
    for (const match of file.noComments.matchAll(CONSOLE_CALL_RE)) {
      findings.push(finding(file, match.index, 'a console call cannot exist in shipped source: log through ctx.logger, and never with a credential'))
    }

    const { code } = file
    for (const match of code.matchAll(PRINT_SINK_RE)) {
      let at = match.index + match[0].length
      while (at < code.length && /[\s?.]/.test(code[at])) at += 1
      if (code[at] !== '(') continue
      const { text, start } = argumentText(code, at)
      sinks.add(`${file.path}:${lineOf(code, match.index)}`)
      for (const identifier of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (!holdsCredentialValue(identifier[0])) continue
        findings.push(
          finding(file, start + identifier.index, `"${identifier[0]}" is passed to a print sink; print the credential NAME or a status, never the value`),
        )
      }
    }
  }

  assert.deepEqual(findings, [], report('a credential value can reach a log', findings))

  // The CLI legitimately prints progress; this records what that looks like, so
  // the check above is known to be looking at real sinks rather than at nothing.
  assert.ok(sinks.size > 0, 'the sink scan found at least one print site in lib/ or bin/')
  assert.ok(
    shipped.some((file) => file.path === 'bin/sync-aa.mjs'),
    'bin/sync-aa.mjs is part of the scanned shipped source',
  )
})

// ---------------------------------------------------------------------------
// check 3 — the environment is read, never written
// ---------------------------------------------------------------------------

test('no environment variable is ever written', () => {
  const findings = []
  for (const file of FILES) {
    for (const match of file.code.matchAll(ENV_WRITE_RE)) {
      findings.push(finding(file, match.index, 'process.env is read-only for this package; writing it would leak into every child process'))
    }
  }
  assert.deepEqual(findings, [], report('the source writes to process.env', findings))
})

// ---------------------------------------------------------------------------
// check 4 — AA_API_KEY is a name, not a value
// ---------------------------------------------------------------------------

/** The default credential name this package uses. */
const CREDENTIAL_NAME = 'AA_API_KEY'

/** Identifier endings that mark a binding as carrying a credential *name*. */
const CREDENTIAL_NAME_BINDING_RE = /(?:ref|name)$/i

/** The harness helper that brands a name: `credentialRef('AA_API_KEY')`. */
const CREDENTIAL_REF_CALL_RE = /\bcredential(?:Ref|Name)\s*\(\s*['"`]AA_API_KEY['"`]\s*\)/

/** Addressing the credential by name: `process.env.AA_API_KEY` or `process.env['AA_API_KEY']`. */
const CREDENTIAL_REFERENCE_RE = /process\s*\.\s*env\s*(?:\.\s*|\[\s*)['"]?$/

/**
 * The identifier this literal is bound to: the nearest `name =` or `name:`
 * before it, searched over the blanked code so a mention inside a comment or a
 * string cannot be mistaken for a binding.
 *
 * @param {string} code Blanked code view of the file.
 * @param {number} index Offset of the literal.
 * @returns {string|null} Binding identifier, or `null` when there is none.
 */
function bindingIdentifier(code, index) {
  let last = null
  for (const match of code.slice(0, index).matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*[:=](?!=)/g)) {
    last = match[1]
  }
  return last
}

test('AA_API_KEY is a credential name, never a fallback value', () => {
  const findings = []
  const mentions = { doc: 0, name: 0, reference: 0 }

  for (const file of FILES) {
    if (!file.path.startsWith('lib/')) continue
    for (const match of file.text.matchAll(new RegExp(CREDENTIAL_NAME, 'g'))) {
      const index = match.index

      // A doc comment names the credential; that is documentation, not a value.
      if (file.noComments[index] === ' ' && file.text[index] !== ' ') {
        mentions.doc += 1
        continue
      }
      // Addressing the credential by name — `process.env.AA_API_KEY` — is the
      // sanctioned read; the env-write check is what catches a write here.
      if (CREDENTIAL_REFERENCE_RE.test(file.text.slice(Math.max(0, index - 24), index))) {
        mentions.reference += 1
        continue
      }
      // `credentialRef('AA_API_KEY')` brands the name, which is the helper's job.
      if (CREDENTIAL_REF_CALL_RE.test(file.text.slice(Math.max(0, index - 40), index + 20))) {
        mentions.name += 1
        continue
      }
      const binding = bindingIdentifier(file.code, index)
      if (binding !== null && CREDENTIAL_NAME_BINDING_RE.test(binding)) {
        mentions.name += 1
        continue
      }
      findings.push(
        finding(
          file,
          index,
          `AA_API_KEY is bound to "${binding ?? 'no binding'}", which does not name a credential; ` +
            'it is the NAME of the credential, so a missing value must come from ctx.credentials or process.env, never from this literal',
        ),
      )
    }
  }

  assert.deepEqual(findings, [], report('AA_API_KEY is used as a credential value', findings))
  assert.ok(mentions.doc + mentions.name + mentions.reference > 0, 'lib/ still names the default credential somewhere')
})

// ---------------------------------------------------------------------------
// the scanner the checks depend on, and the report they produce
// ---------------------------------------------------------------------------

test('the scanner separates code from comments, strings and regex bodies', () => {
  const sample = [
    "// console.log('not code')",
    "const url = 'https://artificialanalysis.ai/models'",
    'const line = `key ${value} for ${route}`',
    String.raw`const quote = /['"]/g`,
    "const nested = `a ${ { b: 'c' } } d`",
    'const divided = total / count',
    'console.log(line)',
  ].join('\n')

  const { code, noComments } = blankLiterals(sample)

  assert.match(code, /console\.log\(line\)/, 'real code survives')
  assert.doesNotMatch(code, /not code/, 'a commented-out call is blanked')
  assert.doesNotMatch(code, /artificialanalysis/, 'a string body is blanked')
  assert.doesNotMatch(code, /\bkey\b/, 'template raw text is blanked')
  assert.match(code, /\$\{value\}/, 'a template interpolation survives')
  assert.match(code, /\$\{route\}/, 'every template interpolation survives')
  assert.match(code, /const divided = total \/ count/, 'division is not mistaken for a regex')
  assert.doesNotMatch(noComments, /not code/, 'the noComments view drops comment text')
  assert.match(noComments, /artificialanalysis\.ai\/models/, 'and keeps literal bodies, which is how a comment is told from a string')

  // The scanner must not lose structure: a desynchronised scan would blank out
  // real code, and every check below would then pass vacuously.
  for (const file of FILES.filter((candidate) => candidate.path.startsWith('lib/') || candidate.path.startsWith('bin/'))) {
    const opens = (file.code.match(/\(/g) ?? []).length
    const closes = (file.code.match(/\)/g) ?? []).length
    assert.equal(opens, closes, `the scanner lost its place in ${file.path} (${opens} "(" vs ${closes} ")")`)
  }
})

test('the scan report names every file and counts every check', (t) => {
  t.diagnostic(`no-secrets: scanned ${FILES.length} file(s)`)
  for (const file of FILES) t.diagnostic(`  scanned ${file.path}`)
  t.diagnostic('no-secrets: checks — 4 (embedded literals, logged values, env writes, credential-name bindings)')
  const shipped = FILES.filter((file) => file.path.startsWith('lib/') || file.path.startsWith('bin/'))
  t.diagnostic(`no-secrets: shipped source scanned: ${shipped.map((file) => file.path).join(', ')}`)
  assert.ok(FILES.length > 0, 'the walk found source files to scan')
  assert.ok(shipped.length >= 2, 'lib/ and bin/ are both represented')
})

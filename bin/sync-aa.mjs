#!/usr/bin/env node
/**
 * Write a LOCAL Artificial Analysis snapshot for `dsh-better-subagents`.
 *
 * Artificial Analysis's Data Platform Terms forbid redistributing their data,
 * which is why this snapshot is a *local convenience* and never a shipped
 * artifact: `data/aa-snapshot.json` is ignored by git, and the plugin reads it
 * only when it is present on the machine that produced it. Everything the
 * plugin renders is still attributed to Artificial Analysis.
 *
 * The CLI is optional. Without it the plugin simply fetches AA's public model
 * pages at lookup time (and the Free-tier index when an API key is configured).
 * With it, a machine that has an AA key can warm a local copy that also covers
 * models whose page fetch would be too slow or unavailable.
 *
 *   node bin/sync-aa.mjs                      # key from AA_API_KEY
 *   node bin/sync-aa.mjs --key=AA_KEY --out=data/aa-snapshot.json
 *
 * Exit codes: 0 success, 1 usage / no key / no data, 2 refused output path,
 * 3 AA answered with an error, 4 the request never completed.
 *
 * The API key is only ever sent as the `x-api-key` header, and is never
 * printed, logged or written to the snapshot.
 *
 * @module dsh-better-subagents/bin/sync-aa
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAaFreeIndex } from '../lib/aa/parse.js'

/** Repository root, resolved from this file rather than from the process cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directory the snapshot is allowed to live in without `--force`. */
const DATA_DIR = resolve(REPO_ROOT, 'data')

/** Default output path. */
const DEFAULT_OUT = resolve(DATA_DIR, 'aa-snapshot.json')

/** Free-tier index endpoint. */
const INDEX_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'

/** Provenance recorded inside the snapshot. */
const SOURCE = INDEX_URL

/** Attribution recorded inside the snapshot, and printed with every summary. */
const ATTRIBUTION = 'Source: Artificial Analysis (artificialanalysis.ai)'

/** Page cap applied when `--max-pages` is omitted. */
const DEFAULT_MAX_PAGES = 10

/** Per-request timeout applied when `--timeout-ms` is omitted. */
const DEFAULT_TIMEOUT_MS = 30_000

/** One line describing how to run this tool. */
const USAGE_LINE =
  'Usage: node bin/sync-aa.mjs [--key=AA_API_KEY] [--out=data/aa-snapshot.json] [--max-pages=10] [--timeout-ms=30000] [--force]'

/** Shown with `--help` and whenever the invocation cannot proceed. */
const HELP = `${USAGE_LINE}

Writes a LOCAL snapshot of Artificial Analysis's Free-tier model index.
Artificial Analysis's Data Platform Terms forbid redistributing their data, so
keep this file on your own machine: data/aa-snapshot.json is git-ignored.

Options:
  --key=<key>           API key (default: the AA_API_KEY environment variable)
  --key-name=<name>     Environment variable to read the key from, instead of AA_API_KEY
  --out=<path>          Output path (default: ${DEFAULT_OUT})
  --max-pages=<n>       Page cap while following pagination (default ${DEFAULT_MAX_PAGES})
  --timeout-ms=<n>      Per-request timeout in ms (default ${DEFAULT_TIMEOUT_MS})
  --force               Allow writing outside the repository's data/ directory
  -h, --help            Show this message

Exit codes: 0 ok, 1 usage/no key/no data, 2 refused output path,
            3 AA error response, 4 request did not complete.`

/**
 * Write to stderr, so stdout stays usable for piping.
 *
 * @param {string} message Message text.
 * @returns {void}
 */
function log(message) {
  process.stderr.write(`${message}\n`)
}

/**
 * An error that already carries the process exit code to use.
 */
class SyncError extends Error {
  /**
   * @param {string} message Human-readable failure.
   * @param {number} exitCode Process exit code.
   */
  constructor(message, exitCode) {
    super(message)
    this.name = 'SyncError'
    this.exitCode = exitCode
  }
}

/**
 * Parse command-line arguments. Both `--flag=value` and `--flag value` are
 * accepted; unknown flags are a usage error rather than a silent no-op.
 *
 * @param {string[]} argv Arguments after `node script`.
 * @returns {{ key: string|null, keyName: string|null, out: string|null, maxPages: number, timeoutMs: number, force: boolean, help: boolean }} Parsed options.
 */
function parseArgs(argv) {
  const options = {
    key: null,
    keyName: null,
    out: null,
    maxPages: DEFAULT_MAX_PAGES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    force: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    const [flag, inline] = splitFlag(arg)
    const takeValue = () => {
      if (inline !== null) return inline
      index += 1
      const next = argv[index]
      if (next === undefined) throw new SyncError(`${flag} needs a value.\n\n${USAGE_LINE}`, 1)
      return next
    }
    if (flag === '--key') {
      const value = takeValue().trim()
      if (value === '') throw new SyncError(`--key needs a non-empty value.\n\n${USAGE_LINE}`, 1)
      options.key = value
      continue
    }
    if (flag === '--out') {
      const value = takeValue().trim()
      if (value === '') throw new SyncError(`--out needs a non-empty value.\n\n${USAGE_LINE}`, 1)
      options.out = value
      continue
    }
    if (flag === '--key-name' || flag === '--key-env') {
      const value = takeValue().trim()
      if (value === '') throw new SyncError(`${flag} needs a non-empty value.\n\n${USAGE_LINE}`, 1)
      options.keyName = value
      continue
    }
    if (flag === '--max-pages') {
      options.maxPages = readPositiveInt(takeValue(), '--max-pages', 1, 100)
      continue
    }
    if (flag === '--timeout-ms') {
      options.timeoutMs = readPositiveInt(takeValue(), '--timeout-ms', 1000, 600_000)
      continue
    }
    if (flag !== null) throw new SyncError(`Unknown option "${flag}".\n\n${USAGE_LINE}`, 1)
    throw new SyncError(`Unexpected argument "${arg}".\n\n${USAGE_LINE}`, 1)
  }
  return options
}

/**
 * Split `--flag=value` into its parts, tolerating a bare `--flag` and ignoring
 * positional arguments (which are reported as unknown).
 *
 * @param {string} arg One argument.
 * @returns {[string|null, string|null]} Flag and inline value.
 */
function splitFlag(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return [null, null]
  const at = arg.indexOf('=')
  if (at < 0) return [arg, null]
  return [arg.slice(0, at), arg.slice(at + 1)]
}

/**
 * Read a bounded positive integer option.
 *
 * @param {string} value Raw option value.
 * @param {string} flag Flag name, for the error message.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} Parsed value.
 */
function readPositiveInt(value, flag, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SyncError(`${flag} must be an integer between ${min} and ${max}.\n\n${USAGE_LINE}`, 1)
  }
  return parsed
}

/**
 * Whether a path is inside a directory (or is that directory).
 *
 * @param {string} target Candidate path.
 * @param {string} directory Directory to test against.
 * @returns {boolean} True when `target` is inside `directory`.
 */
function isInside(target, directory) {
  const rel = relative(directory, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Fetch one index page and return its parsed JSON.
 *
 * Every failure mode becomes a {@link SyncError} with a precise message and an
 * exit code — never a raw response body, and never the key.
 *
 * @param {string} url Page URL (no key in it).
 * @param {string} key API key, sent as the `x-api-key` header.
 * @param {number} timeoutMs Per-request timeout.
 * @returns {Promise<unknown>} Parsed JSON body.
 */
async function fetchIndexPage(url, key, timeoutMs) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': key, accept: 'application/json', 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SyncError(`the request did not complete within ${timeoutMs} ms.`, 4)
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new SyncError(`network error: ${detail}`, 4)
  }

  const status = Number(response?.status ?? 0)
  if (status === 401) {
    throw new SyncError(
      'AA rejected the API key (401 Unauthorized). Check AA_API_KEY / --key.',
      3,
    )
  }
  if (status === 403) {
    throw new SyncError(
      'AA denied access (403 Forbidden): this key may not read the free models endpoint.',
      3,
    )
  }
  if (status === 429) {
    const retryAfter = response?.headers?.get?.('retry-after') ?? null
    const suffix = retryAfter === null ? '' : ` Retry-After: ${retryAfter}s.`
    throw new SyncError(
      `AA rate limit reached (429).${suffix} The free tier allows 100 requests per 24 hours.`,
      3,
    )
  }
  if (status === 404) {
    throw new SyncError('AA answered 404: the free models endpoint is not at this address any more.', 3)
  }
  if (!(typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300)) {
    throw new SyncError(`AA answered HTTP ${status}.`, 3)
  }

  try {
    return await response.json()
  } catch {
    throw new SyncError('AA answered with a body that is not JSON.', 3)
  }
}

/**
 * Walk the index, page by page.
 *
 * @param {object} options Run options.
 * @param {string} options.key API key.
 * @param {number} options.maxPages Page cap.
 * @param {number} options.timeoutMs Per-request timeout.
 * @returns {Promise<{ entries: object[], intelligenceIndexVersion: string|null, tier: string|null, pages: number, capped: boolean }>} Collected rows.
 */
async function collectIndex({ key, maxPages, timeoutMs }) {
  const entries = []
  const seen = new Set()
  let intelligenceIndexVersion = null
  let tier = null
  let pages = 0
  let capped = false

  for (let page = 1; page <= maxPages; page += 1) {
    const url = page === 1 ? INDEX_URL : `${INDEX_URL}?page=${page}`
    const json = await fetchIndexPage(url, key, timeoutMs)
    pages = page

    if (isRecord(json)) {
      if (tier === null && typeof json.tier === 'string') tier = json.tier
      if (intelligenceIndexVersion === null) {
        for (const field of ['intelligence_index_version', 'intelligenceIndexVersion']) {
          const value = json[field]
          if (typeof value === 'string' && value.trim() !== '') {
            intelligenceIndexVersion = value.trim()
            break
          }
        }
      }
    }

    const rows = parseAaFreeIndex(json)
    let added = 0
    for (const row of rows) {
      const key2 = dedupeKey(row)
      if (key2 !== '' && seen.has(key2)) continue
      if (key2 !== '') seen.add(key2)
      entries.push(row)
      added += 1
    }

    const pagination = isRecord(json) && isRecord(json.pagination) ? json.pagination : {}
    const hasMore = pagination.has_more === true
    const totalPages = Number(pagination.total_pages)
    log(
      `[sync-aa] page ${page}: ${rows.length} entries (${added} new, ${entries.length} total)`,
    )

    if (!hasMore) break
    if (Number.isFinite(totalPages) && page >= totalPages) break
    if (page === maxPages) {
      capped = true
      log(`[sync-aa] page cap of ${maxPages} reached while more pages remain (raise --max-pages)`)
    }
  }

  return { entries, intelligenceIndexVersion, tier, pages, capped }
}

/**
 * De-duplication key for one entry.
 *
 * @param {object} entry Normalized entry.
 * @returns {string} Key, or `''` when the entry carries no identity.
 */
function dedupeKey(entry) {
  if (!isRecord(entry)) return ''
  for (const value of [entry.id, entry.slug, entry.name]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * Write the snapshot atomically: a sibling temp file, then one `rename`.
 *
 * @param {string} outPath Final path.
 * @param {object} snapshot Snapshot payload.
 * @returns {Promise<number>} Bytes written.
 */
async function writeSnapshot(outPath, snapshot) {
  const body = `${JSON.stringify(snapshot, null, 2)}\n`
  const bytes = Buffer.byteLength(body, 'utf8')
  const tempPath = `${outPath}.${process.pid}.tmp`
  await mkdir(dirname(outPath), { recursive: true })
  try {
    await writeFile(tempPath, body, 'utf8')
    await rename(tempPath, outPath)
  } catch (error) {
    // Never leave a half-written temp file behind on failure.
    try {
      await unlink(tempPath)
    } catch {
      // Nothing to clean up.
    }
    throw error
  }
  return bytes
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv Arguments after `node script`.
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    log(HELP)
    return 0
  }

  const key = options.key ?? readKeyFromEnvironment(options.keyName)
  if (key === null || key === '') {
    log('No Artificial Analysis API key found.')
    log(`Set AA_API_KEY in the environment${options.keyName === null ? '' : ` (or ${options.keyName})`}, or pass --key=… .`)
    log('')
    log(HELP)
    return 1
  }

  const outPath = options.out === null ? DEFAULT_OUT : resolve(process.cwd(), options.out)
  if (!isInside(outPath, DATA_DIR) && !options.force) {
    log(`Refusing to write outside the repository's data/ directory: ${outPath}`)
    log(`Allowed directory: ${DATA_DIR}`)
    log('Pass --force if you really want that location, or --out=<path inside data/>.')
    return 2
  }

  log(`[sync-aa] fetching ${SOURCE}`)
  const { entries, intelligenceIndexVersion, tier, pages, capped } = await collectIndex({
    key,
    maxPages: options.maxPages,
    timeoutMs: options.timeoutMs,
  })
  log(
    `[sync-aa] ${pages} page(s) read${tier === null ? '' : `, tier=${tier}`}${
      intelligenceIndexVersion === null ? '' : `, index=${intelligenceIndexVersion}`
    }${capped ? ', page cap reached' : ''}`,
  )

  if (entries.length === 0) {
    log('[sync-aa] AA returned no model entries; nothing was written.')
    return 1
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    attribution: ATTRIBUTION,
    intelligenceIndexVersion,
    entries,
  }

  let bytes
  try {
    bytes = await writeSnapshot(outPath, snapshot)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`[sync-aa] could not write ${outPath}: ${detail}`)
    return 1
  }

  log(`[sync-aa] wrote ${entries.length} entries (${bytes} bytes) to ${outPath}`)
  log(`[sync-aa] ${ATTRIBUTION} — local snapshot only; do not redistribute.`)
  return 0
}

/**
 * Read the key from the environment.
 *
 * @param {string|null} keyName Explicit variable name from `--key-name`.
 * @returns {string|null} Key value, never logged.
 */
function readKeyFromEnvironment(keyName) {
  const name = typeof keyName === 'string' && keyName.trim() !== '' ? keyName.trim() : 'AA_API_KEY'
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Whether a value is a plain JSON object.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} True for non-null, non-array objects.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

try {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
} catch (error) {
  if (error instanceof SyncError) {
    log(`[sync-aa] ${error.message}`)
    process.exitCode = error.exitCode
  } else {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log(`[sync-aa] unexpected failure: ${detail}`)
    process.exitCode = 4
  }
}

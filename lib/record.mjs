// Shared helpers for the trajectory hook scripts and the local viewer server.
// Zero dependencies, plain Node ESM.

import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  truncateSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where trajectory logs live: <root>/<sessionId>.jsonl. Override via TRAJECTORY_ROOT (useful for CI/tests). */
export const TRAJECTORY_ROOT = process.env.TRAJECTORY_ROOT || join(homedir(), '.claude', 'trajectories')
/** Where Claude Code keeps its own per-session transcripts. Override via TRANSCRIPT_ROOT. */
export const TRANSCRIPT_ROOT = process.env.TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects')

/** Per-field caps the hooks persist; the viewer can merge full data from the official transcript. */
export const LIMIT_INPUT = 8_000
export const LIMIT_RESULT = 2_000
export const LIMIT_PROMPT = 8_000

/** Current shape of records written by this package. Legacy records without it remain readable. */
export const TRAJECTORY_SCHEMA_VERSION = 1

const LOCK_WAIT_MS = 5
// Windows can take more than a second to schedule a burst of hook processes.
// Keep hooks serialized without treating temporary scheduler pressure as a
// recording failure; the stale-lock guard still bounds abandoned locks.
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

/** Read and parse the JSON hook payload from stdin (tolerant of empty input). */
export function readStdinJson() {
  const raw = readFileSync(0, 'utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

const SECRET_KEY = /(^|_)(key|keys|token|secret|password|passwd|authorization|auth|credential|api[_-]?key|cookie|session)(_|$)/i

/** Mask values whose object key smells like a credential, recursively. */
export function redact(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, seen))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '***' : redact(v, seen)
  }
  return out
}

function stringify(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Truncate a value to `max` chars, marking the cut. */
export function truncate(value, max) {
  const s = value == null ? '' : (typeof value === 'string' ? value : stringify(value))
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s
}

/** Path of one session's trajectory log. */
export function trajectoryPath(sessionId, root = TRAJECTORY_ROOT) {
  return join(root, `${safeSessionId(sessionId)}.jsonl`)
}

function acquireSessionLock(file) {
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      return () => {
        try { closeSync(fd) } finally {
          try { unlinkSync(lock) } catch { /* already removed */ }
        }
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock)
          continue
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue
        throw statErr
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for trajectory lock: ${lock}`)
      Atomics.wait(sleepCell, 0, 0, LOCK_WAIT_MS)
    }
  }
}

/**
 * Parse JSONL and tolerate only a final unterminated JSON fragment. The valid
 * byte count lets the next writer remove that torn tail before appending.
 */
function parseTrajectoryText(text) {
  const lines = text.split('\n')
  const lastNonEmpty = lines.findLastIndex((line) => line.trim())
  const records = []
  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (err) {
      const tornTail = i === lastNonEmpty && !text.endsWith('\n')
      if (!tornTail) throw new Error(`invalid trajectory JSONL at line ${i + 1}`, { cause: err })
      const prefix = lines.slice(0, i).join('\n') + (i > 0 ? '\n' : '')
      return { records, validBytes: Buffer.byteLength(prefix), tornTail: true, needsNewline: false }
    }
  }
  return {
    records,
    validBytes: Buffer.byteLength(text),
    tornTail: false,
    needsNewline: text.length > 0 && !text.endsWith('\n'),
  }
}

/** Append one trajectory record with a cross-process per-session lock. */
export function appendRecord(sessionId, rec, options = {}) {
  const root = options.root || TRAJECTORY_ROOT
  const file = trajectoryPath(sessionId, root)
  mkdirSync(root, { recursive: true })
  const release = acquireSessionLock(file)
  try {
    const parsed = existsSync(file)
      ? parseTrajectoryText(readFileSync(file, 'utf8'))
      : { records: [], validBytes: 0, tornTail: false, needsNewline: false }
    if (parsed.tornTail) truncateSync(file, parsed.validBytes)
    const previousSeq = parsed.records.at(-1)?.seq
    const seq = Number.isSafeInteger(previousSeq) && previousSeq >= 0
      ? previousSeq + 1
      : parsed.records.length + 1
    const record = {
      ...rec,
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      seq,
      ts: rec.ts ?? Date.now(),
    }
    appendFileSync(file, `${parsed.needsNewline ? '\n' : ''}${stringify(record)}\n`, 'utf8')
    return record
  } finally {
    release()
  }
}

/** Parse a trajectory log back into records (used by the viewer server). */
export function loadTrajectory(sessionId, options = {}) {
  const file = trajectoryPath(sessionId, options.root || TRAJECTORY_ROOT)
  if (!existsSync(file)) return []
  return parseTrajectoryText(readFileSync(file, 'utf8')).records
}

/** Make an arbitrary session id safe for use in a file name. */
export function safeSessionId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Standard hook entry: parse stdin, build one record, append it, always exit 0.
 * A recording hook must never affect the agent loop, so any failure is logged
 * to the trajectory-errors log and swallowed.
 */
export function runHook(name, build) {
  try {
    const payload = readStdinJson()
    const rec = build(payload)
    if (rec && payload.session_id) appendRecord(safeSessionId(payload.session_id), rec)
  } catch (err) {
    try {
      mkdirSync(TRAJECTORY_ROOT, { recursive: true })
      appendFileSync(join(TRAJECTORY_ROOT, '..', 'trajectory-errors.log'), `${new Date().toISOString()} [${name}] ${err?.stack ?? err}\n`)
    } catch {
      // nothing else we can do from a hook
    }
  }
  process.exit(0)
}

/** Root of this plugin checkout (used by the viewer server and install script). */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

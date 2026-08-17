// Shared helpers for the trajectory hook scripts and the local viewer server.
// Zero dependencies, plain Node ESM.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
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
  const s = typeof value === 'string' ? value : stringify(value)
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s
}

/** Path of one session's trajectory log. */
export function trajectoryPath(sessionId) {
  return join(TRAJECTORY_ROOT, `${sessionId}.jsonl`)
}

/** Append one trajectory record, assigning a per-file sequence number. */
export function appendRecord(sessionId, rec) {
  const file = trajectoryPath(sessionId)
  mkdirSync(TRAJECTORY_ROOT, { recursive: true })
  const seq = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
  appendFileSync(file, `${stringify({ seq: seq + 1, ts: Date.now(), ...rec })}\n`, 'utf8')
}

/** Parse a trajectory log back into records (used by the viewer server). */
export function loadTrajectory(sessionId) {
  const file = trajectoryPath(sessionId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
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

#!/usr/bin/env node
/**
 * Zero-dependency local server for the trajectory viewer.
 *
 *   node viewer/serve.mjs [port]          (default 8611)
 *
 * Routes:
 *   /                        viewer/index.html
 *   /api/sessions            trajectory logs under TRAJECTORY_ROOT
 *   /api/trajectory/<id>     parsed records of one trajectory log
 *   /api/transcripts         official CC transcripts under TRANSCRIPT_ROOT (capped at 300)
 *   /api/transcript?path=    parsed lines of one official transcript
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve, relative, sep } from 'node:path'
import {
  TRAJECTORY_ROOT,
  TRANSCRIPT_ROOT,
  loadTrajectory,
  redact,
  truncate,
  PLUGIN_ROOT,
  safeSessionId,
} from '../lib/record.mjs'

const PORT = Number(process.argv[2] || process.env.PORT || 8611)
const VIEWER_DIR = join(PLUGIN_ROOT, 'viewer')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

// Caps applied when serving official transcripts so responses stay small.
const CAPS = { input: 20_000, result: 50_000, text: 30_000 }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function listTrajectorySessions() {
  if (!existsSync(TRAJECTORY_ROOT)) return []
  return readdirSync(TRAJECTORY_ROOT)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const st = statSync(join(TRAJECTORY_ROOT, f))
      return { id: f.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function listTranscripts() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= 300) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = statSync(join(dir, e.name))
        out.push({ path: join(dir, e.name), rel: relative(TRANSCRIPT_ROOT, join(dir, e.name)), mtimeMs: st.mtimeMs, size: st.size })
      }
    }
  }
  walk(TRANSCRIPT_ROOT, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, 300)
}

/** Redact, then either return the value or a truncated string when the JSON is too large. */
function capped(v, max) {
  const r = redact(v)
  const s = JSON.stringify(r)
  return s && s.length > max ? truncate(r, max) : r
}

function sanitizeTranscriptLine(line) {
  const out = redact(line)
  if (typeof out.content === 'string') out.content = truncate(out.content, CAPS.text)
  if (Array.isArray(out.content)) {
    out.content = out.content.map((b) => {
      if (b && typeof b.text === 'string') b.text = truncate(b.text, CAPS.text)
      if (b && b.type === 'tool_use') b.input = capped(b.input, CAPS.input)
      if (b && b.type === 'tool_result') b.content = capped(b.content, CAPS.result)
      return b
    })
  }
  return out
}

function readTranscriptLines(path) {
  const abs = resolve(path)
  if (!abs.startsWith(TRANSCRIPT_ROOT + sep) || !abs.endsWith('.jsonl') || !existsSync(abs)) {
    throw new Error('transcript must live under the Claude Code projects dir')
  }
  return readFileSync(abs, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .map(sanitizeTranscriptLine)
}

// --- optional SQLite projection (built by scripts/project-sqlite.mjs) ---
let db = null
let dbError = null
async function getDb() {
  if (db) return db
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({ DatabaseSync: null }))
  if (!DatabaseSync) {
    dbError = 'node:sqlite unavailable (needs Node >= 22.13)'
    return null
  }
  const file = join(TRAJECTORY_ROOT, 'trajectory.db')
  if (!existsSync(file)) {
    dbError = 'no trajectory.db — run: node scripts/project-sqlite.mjs'
    return null
  }
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
  } catch {
    db = new DatabaseSync(file, { timeout: 5000 })
  }
  return db
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (url.pathname === '/api/sessions') return sendJson(res, 200, listTrajectorySessions())
    if (url.pathname.startsWith('/api/trajectory/')) {
      const id = safeSessionId(decodeURIComponent(url.pathname.slice('/api/trajectory/'.length)))
      const file = join(TRAJECTORY_ROOT, `${id}.jsonl`)
      if (!existsSync(file)) return sendJson(res, 404, { error: `no trajectory for ${id}` })
      return sendJson(res, 200, { id, records: loadTrajectory(id) })
    }
    if (url.pathname === '/api/transcripts') return sendJson(res, 200, listTranscripts())
    if (url.pathname === '/api/transcript') {
      const p = url.searchParams.get('path')
      if (!p) return sendJson(res, 400, { error: 'missing path' })
      try {
        return sendJson(res, 200, { lines: readTranscriptLines(p) })
      } catch (e) {
        return sendJson(res, 403, { error: e.message })
      }
    }
    if (url.pathname === '/api/stats') {
      const d = await getDb()
      if (!d) return sendJson(res, 200, { error: dbError })
      const sessions = d.prepare(`SELECT session_id AS id, COUNT(*) AS records, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
        (MAX(ts) - MIN(ts)) / 1000.0 AS duration_s,
        SUM(type='user') AS prompts, SUM(type='tool') AS tools,
        SUM(type='permission' AND decision='denied') AS denials,
        SUM(type='subagent-start') AS subagents
        FROM records GROUP BY session_id ORDER BY last_ts DESC`).all()
      const topTools = d.prepare(`SELECT tool, COUNT(*) AS calls FROM records
        WHERE type IN ('tool', 'tool-start') AND tool IS NOT NULL
        GROUP BY tool ORDER BY calls DESC LIMIT 12`).all()
      return sendJson(res, 200, { sessions, topTools })
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim()
      if (!q) return sendJson(res, 400, { error: 'missing q' })
      const d = await getDb()
      if (!d) return sendJson(res, 200, { error: dbError })
      const like = '%' + q + '%'
      const rows = d.prepare(`SELECT session_id AS sessionId, ts, type, tool, substr(payload, 1, 240) AS snippet
        FROM records WHERE payload LIKE ? OR session_id LIKE ?
        ORDER BY ts DESC LIMIT 200`).all(like, like)
      return sendJson(res, 200, { rows })
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = resolve(VIEWER_DIR, rel)
    if (!file.startsWith(VIEWER_DIR + sep)) return sendText(res, 403, 'forbidden')
    if (!existsSync(file) || statSync(file).isDirectory()) return sendText(res, 404, 'not found')
    sendText(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`trajectory viewer: http://127.0.0.1:${PORT}`)
})

#!/usr/bin/env node
/**
 * Zero-dependency local server for the trajectory viewer.
 *
 *   node dist/viewer/serve.js [port]      (default 8611)
 *
 * Routes:
 *   /                        viewer/index.html
 *   /api/sessions            trajectory logs under TRAJECTORY_ROOT
 *   /api/trajectory/<id>     parsed records of one trajectory log
 *   /api/transcripts         official CC transcripts under TRANSCRIPT_ROOT (capped at 300)
 *   /api/transcript?path=    parsed lines of one official transcript
 */
import { createServer } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, extname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRAJECTORY_ROOT,
  TRANSCRIPT_ROOT,
  loadTrajectory,
  redact,
  truncate,
  PLUGIN_ROOT,
  safeSessionId,
} from '../lib/record.js'

const PORT = Number(process.argv[2] || process.env.PORT || 8611)
const VIEWER_DIR = dirname(fileURLToPath(import.meta.url))
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
  const out: Array<{ path: string; rel: string; mtimeMs: number; size: number }> = []
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

function transcriptStat(path) {
  const abs = resolve(path)
  if (!abs.startsWith(TRANSCRIPT_ROOT + sep) || !abs.endsWith('.jsonl') || !existsSync(abs)) {
    throw new Error('transcript must live under the Claude Code projects dir')
  }
  const stat = statSync(abs)
  return { mtimeMs: stat.mtimeMs, size: stat.size }
}

// --- optional SQLite projection (built by trajectory project) ---
let db: DatabaseSync | null = null
let dbError: string | null = null
async function getDb() {
  if (db) return db
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({ DatabaseSync: null }))
  if (!DatabaseSync) {
    dbError = 'node:sqlite unavailable (needs Node >= 22.13)'
    return null
  }
  const file = join(TRAJECTORY_ROOT, 'trajectory.db')
  if (!existsSync(file)) {
    dbError = 'no trajectory.db — run: trajectory project'
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
      const records = loadTrajectory(id)
      const stat = statSync(file)
      const version = { mtimeMs: stat.mtimeMs, size: stat.size }
      if (!url.searchParams.has('limit')) return sendJson(res, 200, { id, records, version })
      const limit = Number(url.searchParams.get('limit'))
      const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        return sendJson(res, 400, { error: 'limit must be an integer between 1 and 500' })
      }
      if (before != null && (!Number.isSafeInteger(before) || before < 1)) {
        return sendJson(res, 400, { error: 'before must be a positive integer seq' })
      }
      const eligible = before == null ? records : records.filter((record) => record.seq < before)
      const pageRecords = eligible.slice(-limit)
      return sendJson(res, 200, {
        id,
        records: pageRecords,
        version,
        meta: records.find((record) => record.type === 'session') ?? null,
        page: {
          total: records.length,
          hasMore: eligible.length > pageRecords.length,
          before: pageRecords[0]?.seq ?? null,
        },
      })
    }
    if (url.pathname === '/api/transcripts') return sendJson(res, 200, listTranscripts())
    if (url.pathname === '/api/transcript') {
      const p = url.searchParams.get('path')
      if (!p) return sendJson(res, 400, { error: 'missing path' })
      try {
        return sendJson(res, 200, { lines: readTranscriptLines(p), version: transcriptStat(p) })
      } catch (e: any) {
        return sendJson(res, 403, { error: e.message })
      }
    }
    if (url.pathname === '/api/version') {
      const idParam = url.searchParams.get('id')
      const transcriptPath = url.searchParams.get('path')
      const result: { app: string; trajectory?: unknown; transcript?: unknown } = { app: 'agent-trajectory' }
      if (idParam) {
        const id = safeSessionId(idParam)
        const file = join(TRAJECTORY_ROOT, `${id}.jsonl`)
        if (existsSync(file)) {
          const stat = statSync(file)
          result.trajectory = { mtimeMs: stat.mtimeMs, size: stat.size }
        }
      }
      if (transcriptPath) {
        try {
          result.transcript = transcriptStat(transcriptPath)
        } catch (error: any) {
          return sendJson(res, 403, { error: error.message })
        }
      }
      return sendJson(res, 200, result)
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
      const hasFts = d.prepare(`SELECT 1 AS found FROM sqlite_master
        WHERE type='table' AND name='record_fts'`).get()
      if (hasFts) {
        const phrase = `"${q.replaceAll('"', '""')}"`
        const rows = d.prepare(`SELECT session_id AS sessionId, seq, type, tool,
          snippet(record_fts, 4, '', '', '…', 24) AS snippet
          FROM record_fts WHERE record_fts MATCH ? ORDER BY rank LIMIT 200`).all(phrase)
        if (rows.length) return sendJson(res, 200, { rows, engine: 'fts5' })
      }
      const like = '%' + q + '%'
      const rows = d.prepare(`SELECT session_id AS sessionId, seq, ts, type, tool, substr(payload, 1, 240) AS snippet
        FROM records WHERE payload LIKE ? OR session_id LIKE ?
        ORDER BY ts DESC LIMIT 200`).all(like, like)
      return sendJson(res, 200, { rows, engine: hasFts ? 'like-fallback' : 'like' })
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = resolve(VIEWER_DIR, rel)
    if (!file.startsWith(VIEWER_DIR + sep)) return sendText(res, 403, 'forbidden')
    if (!existsSync(file) || statSync(file).isDirectory()) return sendText(res, 404, 'not found')
    sendText(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
  } catch (err: any) {
    sendJson(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`trajectory viewer: http://127.0.0.1:${PORT}`)
})

#!/usr/bin/env node
/**
 * Project trajectory logs into SQLite for multi-session search and stats.
 * Uses the built-in node:sqlite module (Node >= 22.13).
 *
 *   node scripts/project-sqlite.mjs                       # import + summary
 *   node scripts/project-sqlite.mjs --report              # import + full tables
 *   node scripts/project-sqlite.mjs --sql "SELECT ..."    # raw query
 *   node scripts/project-sqlite.mjs --db <path> --trajectory-root <dir>
 *
 * The viewer server picks up <trajectory-root>/trajectory.db automatically
 * (/api/stats, /api/search).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TRAJECTORY_ROOT } from '../lib/record.mjs'

function parseArgs(argv) {
  const out = { db: join(TRAJECTORY_ROOT, 'trajectory.db'), root: TRAJECTORY_ROOT, report: false, sql: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i]
    else if (a === '--trajectory-root') out.root = argv[++i]
    else if (a === '--report') out.report = true
    else if (a === '--sql') out.sql = argv[++i]
    else if (a === '--help') {
      console.log('usage: node scripts/project-sqlite.mjs [--db <path>] [--trajectory-root <dir>] [--report] [--sql <query>]')
      process.exit(0)
    }
  }
  return out
}

const { DatabaseSync } = await import('node:sqlite').catch(() => ({}))
if (!DatabaseSync) {
  console.error('node:sqlite is unavailable — requires Node >= 22.13')
  process.exit(1)
}

const opts = parseArgs(process.argv.slice(2))
const db = new DatabaseSync(opts.db)
const hadFts = !!db.prepare(`SELECT 1 AS found FROM sqlite_master
  WHERE type='table' AND name='record_fts'`).get()
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  model TEXT,
  source TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  records INTEGER
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER,
  ts INTEGER,
  type TEXT NOT NULL,
  tool TEXT,
  tool_use_id TEXT,
  decision TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
`)

const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
if (!sessionColumns.has('file_size')) db.exec('ALTER TABLE sessions ADD COLUMN file_size INTEGER')
if (!sessionColumns.has('file_mtime_ms')) db.exec('ALTER TABLE sessions ADD COLUMN file_mtime_ms REAL')

db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(
  session_id, seq UNINDEXED, type, tool, content, tokenize='unicode61'
)`)

const insertRec = db.prepare(`INSERT INTO records (session_id, seq, ts, type, tool, tool_use_id, decision, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
const insertFts = db.prepare(`INSERT INTO record_fts (session_id, seq, type, tool, content)
  VALUES (?, ?, ?, ?, ?)`)
const insertSess = db.prepare(`INSERT OR REPLACE INTO sessions
  (id, cwd, model, source, first_ts, last_ts, records, file_size, file_mtime_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const readSnapshot = db.prepare('SELECT file_size, file_mtime_ms FROM sessions WHERE id = ?')

function importSession(file) {
  const id = file.slice(0, -6)
  const path = join(opts.root, file)
  const stat = statSync(path)
  const snapshot = readSnapshot.get(id)
  if (hadFts && snapshot?.file_size === stat.size && snapshot?.file_mtime_ms === stat.mtimeMs) {
    return { imported: false, records: 0 }
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const recs = lines.map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }).filter(Boolean)
  if (!recs.length) return { imported: false, records: 0 }

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM records WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM record_fts WHERE session_id = ?').run(id)
    let firstTs = null
    let lastTs = null
    let meta = {}
    for (const r of recs) {
      if (r.type === 'session') meta = r
      if (r.ts != null) {
        if (firstTs == null || r.ts < firstTs) firstTs = r.ts
        if (lastTs == null || r.ts > lastTs) lastTs = r.ts
      }
      const payload = JSON.stringify(r)
      insertRec.run(id, r.seq ?? null, r.ts ?? null, r.type ?? 'unknown', r.tool ?? null, r.toolUseId ?? null, r.decision ?? null, payload)
      insertFts.run(id, r.seq ?? null, r.type ?? 'unknown', r.tool ?? '', payload)
    }
    insertSess.run(id, meta.cwd ?? null, meta.model ?? null, meta.source ?? null, firstTs, lastTs, recs.length, stat.size, stat.mtimeMs)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { imported: true, records: recs.length }
}

function report() {
  console.log('\n== per-session ==')
  console.table(db.prepare(`
    SELECT session_id AS session, COUNT(*) AS records, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
           (MAX(ts) - MIN(ts)) / 1000.0 AS duration_s,
           SUM(type='user') AS prompts, SUM(type='tool') AS tools,
           SUM(type='permission' AND decision='denied') AS denials,
           SUM(type='subagent-start') AS subagents
    FROM records GROUP BY session_id ORDER BY last_ts DESC`).all())

  console.log('== top tools (all sessions) ==')
  console.table(db.prepare(`
    SELECT tool, COUNT(*) AS calls FROM records
    WHERE type IN ('tool', 'tool-start') AND tool IS NOT NULL
    GROUP BY tool ORDER BY calls DESC LIMIT 12`).all())

  console.log('== totals ==')
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM records) AS records,
           (SELECT COUNT(*) FROM records WHERE type='tool') AS tool_calls,
           (SELECT COUNT(*) FROM records WHERE type='permission' AND decision='denied') AS denials`).get()
  console.table(totals)
}

if (opts.sql) {
  const rows = db.prepare(opts.sql).all()
  console.table(rows)
  process.exit(0)
}

const files = readdirSync(opts.root).filter((f) => f.endsWith('.jsonl'))
const fileIds = new Set(files.map((file) => file.slice(0, -6)))
const staleIds = db.prepare('SELECT id FROM sessions').all()
  .map((row) => row.id)
  .filter((id) => !fileIds.has(id))
if (staleIds.length) {
  db.exec('BEGIN')
  try {
    const deleteRecords = db.prepare('DELETE FROM records WHERE session_id = ?')
    const deleteFts = db.prepare('DELETE FROM record_fts WHERE session_id = ?')
    const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
    for (const id of staleIds) {
      deleteRecords.run(id)
      deleteFts.run(id)
      deleteSession.run(id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
let total = 0
let imported = 0
for (const f of files) {
  const result = importSession(f)
  total += result.records
  if (result.imported) imported++
}
console.log('indexed', imported, 'changed sessions,', total, 'records; skipped', files.length - imported,
  'unchanged; removed', staleIds.length, 'stale ->', opts.db)
if (opts.report) report()

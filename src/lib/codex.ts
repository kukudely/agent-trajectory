import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { redact, truncate } from './record.js'

export const CODEX_ROOT = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
export const CODEX_SESSIONS_ROOT = resolve(process.env.CODEX_SESSIONS_ROOT || join(CODEX_ROOT, 'sessions'))
export const CODEX_ARCHIVED_ROOT = resolve(process.env.CODEX_ARCHIVED_ROOT || join(CODEX_ROOT, 'archived_sessions'))
export const CODEX_INDEX = resolve(process.env.CODEX_SESSION_INDEX || join(CODEX_ROOT, 'session_index.jsonl'))

const CAPS = { input: 20_000, result: 50_000, text: 30_000 }
type CodexFile = { id: string; path: string; rel: string; archived: boolean; mtimeMs: number; size: number }
const sessionCache = new Map<string, any>()

function jsonLines(path: string) {
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
  })
}

function readWindow(path: string, length = 128 * 1024) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, length))
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes).toString('utf8').split('\n').flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
    })
  } finally {
    closeSync(fd)
  }
}

function compact(value: unknown, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function contentText(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'input_text' || block?.type === 'output_text' || block?.text != null)
    .map((block) => block.text ?? '').join('\n')
}

function sessionIndex() {
  const titles = new Map<string, string>()
  if (!existsSync(CODEX_INDEX)) return titles
  for (const row of jsonLines(CODEX_INDEX)) {
    const title = compact(row.thread_name)
    if (row.id && title) titles.set(String(row.id), title)
  }
  return titles
}

function rolloutId(path: string, rows?: any[]) {
  const fromMeta = rows?.find((row) => row.type === 'session_meta')?.payload?.id
  if (fromMeta) return String(fromMeta)
  const match = basename(path, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)
  return match?.[1] ?? basename(path, '.jsonl')
}

function collect(root: string, archived: boolean, out: CodexFile[], depth = 0) {
  if (depth > 5 || !existsSync(root)) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) collect(path, archived, out, depth + 1)
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const stat = statSync(path)
      const head = readWindow(path)
      out.push({ id: rolloutId(path, head), path, rel: relative(CODEX_ROOT, path), archived, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
}

export function listCodexSessions(limit = 300) {
  const files: CodexFile[] = []
  collect(CODEX_SESSIONS_ROOT, false, files)
  collect(CODEX_ARCHIVED_ROOT, true, files)
  const titles = sessionIndex()
  const sessions = files.map((file) => {
    const head = readWindow(file.path)
    const meta = head.find((row) => row.type === 'session_meta')?.payload
    const firstUser = head.find((row) => row.type === 'response_item' && row.payload?.type === 'message' && row.payload?.role === 'user')
    const title = titles.get(file.id) || compact(contentText(firstUser?.payload?.content)) || compact(meta?.cwd && basename(String(meta.cwd))) || file.id
    return { ...file, title, cwd: meta?.cwd ?? null, source: 'codex' }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs)
  sessionCache.clear()
  for (const session of sessions) sessionCache.set(session.id, session)
  return sessions.slice(0, limit)
}

export function codexSessionFile(id: string) {
  const cached = sessionCache.get(id)
  if (cached && existsSync(cached.path)) return cached
  return listCodexSessions(2_000).find((session) => session.id === id) ?? null
}

function capped(value: unknown, max: number) {
  const safe = redact(value)
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe)
  return text.length > max ? truncate(safe, max) : safe
}

function timestamp(row: any) {
  const value = Date.parse(row.timestamp)
  return Number.isFinite(value) ? value : Date.now()
}

export function readCodexTrajectory(id: string) {
  const session = codexSessionFile(id)
  if (!session) return null
  const rows = jsonLines(session.path)
  const firstTurn = rows.find((row) => row.type === 'turn_context')?.payload
  const calls = new Map<string, { tool: string; input: unknown; ts: number }>()
  const records: any[] = []
  let latestUsage: any = null
  const push = (record: any) => records.push({ seq: records.length + 1, schemaVersion: 1, source: 'codex', ...record })

  for (const row of rows) {
    const payload = row.payload || {}
    const ts = timestamp(row)
    if (row.type === 'session_meta') {
      push({ type: 'session', ts, cwd: payload.cwd, model: firstTurn?.model || payload.model_provider, sessionId: id })
    } else if (row.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'user' || payload.role === 'assistant') {
        const text = truncate(contentText(payload.content), CAPS.text)
        if (text.trim()) push({ type: payload.role, ts, text })
      }
    } else if (row.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payload.type)) {
      const callId = String(payload.call_id || payload.id || `call-${records.length + 1}`)
      const call = { tool: String(payload.name || 'tool'), input: capped(payload.input ?? payload.arguments, CAPS.input), ts }
      calls.set(callId, call)
      push({ type: 'tool-start', ts, toolUseId: callId, tool: call.tool, input: call.input })
    } else if (row.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
      const callId = String(payload.call_id || payload.id || `call-${records.length + 1}`)
      const call = calls.get(callId)
      push({ type: 'tool', ts, toolUseId: callId, tool: call?.tool || 'tool', input: call?.input ?? null, result: capped(payload.output, CAPS.result) })
    } else if (row.type === 'event_msg' && payload.type === 'token_count') {
      latestUsage = payload.info?.total_token_usage || null
    } else if (row.type === 'event_msg' && payload.type === 'task_complete') {
      if (latestUsage) push({ type: 'usage', ts,
        inputTokens: latestUsage.input_tokens ?? 0,
        outputTokens: latestUsage.output_tokens ?? 0,
        cacheReadInputTokens: latestUsage.cached_input_tokens ?? 0,
        reasoningOutputTokens: latestUsage.reasoning_output_tokens ?? 0 })
      push({ type: 'turn-end', ts, lastAssistantMessage: truncate(payload.last_agent_message, CAPS.text) })
    } else if (row.type === 'event_msg' && payload.type === 'turn_aborted') {
      push({ type: 'turn-end', ts, reason: payload.reason || 'aborted' })
    }
  }
  const stat = statSync(session.path)
  return { id, records, meta: records.find((record) => record.type === 'session') ?? null,
    version: { mtimeMs: stat.mtimeMs, size: stat.size }, session }
}

export function codexSessionStat(id: string) {
  const session = codexSessionFile(id)
  if (!session) return null
  const stat = statSync(session.path)
  return { mtimeMs: stat.mtimeMs, size: stat.size }
}

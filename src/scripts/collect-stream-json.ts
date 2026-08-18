#!/usr/bin/env node
/**
 * Route B collector: consume `claude --output-format stream-json` output and
 * write trajectory records (including token usage) to the same JSONL store, so
 * the viewer can render headless runs with assistant text and token telemetry.
 *
 * Usage:
 *   claude --output-format stream-json -p "task" | trajectory-collect
 *   npm run collect -- --file run.log
 *   npm run collect -- --session-id <id> --out <dir>
 *
 * The --file form reads a previously saved stream-json log; --out overrides
 * the trajectory root. If no --session-id is given, it is taken from the
 * system init event.
 */
import { readFileSync } from 'node:fs'
import { redact, truncate, appendRecord, safeSessionId, TRAJECTORY_ROOT } from '../lib/record.js'

const LIMIT_TEXT = 30_000
const LIMIT_INPUT = 8_000
const LIMIT_RESULT = 2_000

function parseArgs(argv) {
  const out = { file: null, sessionId: null, root: TRAJECTORY_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file') out.file = argv[++i]
    else if (a === '--session-id') out.sessionId = argv[++i]
    else if (a === '--out') out.root = argv[++i]
    else if (a === '--help') {
      console.log('usage: npm run collect -- [--file <log>] [--session-id <id>] [--out <dir>]')
      process.exit(0)
    }
  }
  return out
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  const out: Record<string, number> = {}
  if (u.input_tokens != null) out.inputTokens = u.input_tokens
  if (u.output_tokens != null) out.outputTokens = u.output_tokens
  if (u.cache_read_input_tokens != null) out.cacheReadInputTokens = u.cache_read_input_tokens
  if (u.cache_creation_input_tokens != null) out.cacheCreationInputTokens = u.cache_creation_input_tokens
  return Object.keys(out).length ? out : null
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const raw = opts.file ? readFileSync(opts.file, 'utf8') : readFileSync(0, 'utf8')

  let sessionId = opts.sessionId ? safeSessionId(opts.sessionId) : null
  const cum = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev.type !== 'string') continue

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (!sessionId && ev.session_id) sessionId = safeSessionId(ev.session_id)
      if (sessionId) {
        appendRecord(sessionId, {
          type: 'session',
          transcriptPath: '',
          cwd: ev.cwd ?? '',
          source: 'stream-json',
          model: ev.model,
        }, { root: opts.root })
      }
      continue
    }

    if (!sessionId) continue // ignore events before we know the session

    if (ev.type === 'assistant') {
      const msg = ev.message ?? ev
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (text.trim()) {
        appendRecord(sessionId, { type: 'assistant', text: truncate(text, LIMIT_TEXT) }, { root: opts.root })
      }
      for (const b of blocks.filter((b) => b.type === 'tool_use')) {
        appendRecord(sessionId, {
          type: 'tool-start',
          toolUseId: b.id,
          tool: b.name,
          input: truncate(redact(b.input), LIMIT_INPUT),
        }, { root: opts.root })
      }
      const u = usageOf(msg.usage)
      if (u) emitUsage(sessionId, u, cum, 'message', opts.root)
      continue
    }

    if (ev.type === 'user') {
      const msg = ev.message ?? ev
      const blocks = Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks.filter((b) => b.type === 'tool_result')) {
        appendRecord(sessionId, {
          type: 'tool',
          toolUseId: b.tool_use_id,
          result: truncate(redact(textOf(b.content)), LIMIT_RESULT),
          isError: !!b.is_error,
        }, { root: opts.root })
      }
      continue
    }

    if (ev.type === 'stream_event') {
      const e = ev.event ?? {}
      if (e.type === 'message_delta') {
        const u = usageOf(e.usage)
        if (u) emitUsage(sessionId, u, cum, 'delta', opts.root)
      }
      continue
    }

    if (ev.type === 'result') {
      appendRecord(sessionId, { type: 'session-end', outcome: ev.subtype ?? '' }, { root: opts.root })
      if (ev.subtype && String(ev.subtype).startsWith('error_')) {
        appendRecord(sessionId, { type: 'turn-end', reason: ev.subtype }, { root: opts.root })
      }
      continue
    }
  }

  if (!sessionId) {
    console.error('no session id found: pass --session-id or feed a stream-json log with a system init event')
    process.exit(1)
  }
  console.log('records appended for', sessionId, 'at', opts.root)
}

function emitUsage(sessionId, u, cum, kind, root) {
  for (const k of Object.keys(cum)) {
    if (u[k] != null) cum[k] += u[k]
  }
  appendRecord(sessionId, { type: 'usage', kind, ...cum }, { root })
}

main()

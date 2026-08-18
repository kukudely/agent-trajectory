const $ = (id: string): any => document.getElementById(id)
const state: any = {
  sessions: [], transcripts: [], current: null, records: null, transcript: null,
  trajectoryMeta: null, trajectoryVersion: null, transcriptVersion: null,
  merge: true, search: '', page: null, refreshInFlight: false,
  selectedKey: null, selectedItem: null, inspectorTab: 'summary',
}
const TRAJECTORY_PAGE_SIZE = 200

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
const fmtTs = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
const div = (cls: string, html?: string) => { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d }

function jsonPre(v) {
  if (v == null) return ''
  let s = v
  if (typeof s === 'string') { try { s = JSON.parse(s) } catch (e) { return esc(s) } }
  try { return esc(JSON.stringify(s, null, 2)) } catch (e) { return esc(String(v)) }
}
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && b.text != null ? b.text : '')).join('\n')
  return ''
}
// Official CC transcripts nest payload under `message.content`; stream-json is
// flat at `line.content`. Support both so the merge view works on either source.
const msgContent = (line) => (line && line.message && line.message.content != null ? line.message.content : line.content)

async function api(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error((await r.text()) || String(r.status))
  return r.json()
}

function select(kind, key) {
  const lists = [['sessionList', 'trajectory'], ['transcriptList', 'transcript']]
  for (const [listId, k] of lists) {
    for (const li of $(listId).children) {
      li.classList.toggle('active', k === kind && li.dataset.key === String(key))
    }
  }
}

async function loadSessions() {
  try {
    const [s, t] = await Promise.all([api('/api/sessions'), api('/api/transcripts')])
    state.sessions = s
    state.transcripts = t
    const sl = $('sessionList')
    sl.innerHTML = ''
    if (!s.length) sl.innerHTML = '<li class="hint">暂无轨迹。先运行 <code>npm run demo</code>，或用 hooks 跑一个真实会话。</li>'
    for (const it of s) {
      const li = document.createElement('li')
      li.dataset.key = it.id
      li.title = it.id
      li.innerHTML = '<div>' + esc(it.title || it.id) + '</div><div class="t">' + fmtTs(it.mtimeMs) + ' · ' + fmtSize(it.size) + '</div>'
      li.onclick = () => { select('trajectory', it.id); openTrajectory(it.id) }
      sl.appendChild(li)
    }
    const tl = $('transcriptList')
    tl.innerHTML = ''
    if (!t.length) tl.innerHTML = '<li class="hint">未找到 transcript 文件。</li>'
    for (const it of t) {
      const li = document.createElement('li')
      li.dataset.key = it.path
      li.title = it.rel
      li.innerHTML = '<div>' + esc(it.title || it.rel.split('\\').pop()) + '</div><div class="t">' + esc(it.rel) + ' · ' + fmtTs(it.mtimeMs) + '</div>'
      li.onclick = () => { select('transcript', it.path); openTranscript(it.path) }
      tl.appendChild(li)
    }
  } catch (e) {
    console.error('loadSessions failed', e)
  }
}

async function openTrajectory(id, options: { followTail?: boolean } = {}) {
  const timeline = $('timeline')
  const wasNearTail = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 120
  if (state.current?.kind !== 'trajectory' || state.current.id !== id) {
    state.selectedKey = null
    state.selectedItem = null
  }
  state.current = { kind: 'trajectory', id }
  state.page = null
  state.trajectoryMeta = null
  state.transcriptVersion = null
  try {
    const suffix = state.merge ? '' : '?limit=' + TRAJECTORY_PAGE_SIZE
    const data = await api('/api/trajectory/' + encodeURIComponent(id) + suffix)
    state.records = data.records
    state.page = data.page || null
    state.trajectoryMeta = data.meta || null
    state.trajectoryVersion = data.version || null
  } catch (e) {
    state.records = null
  }
  state.transcript = null
  if (state.merge && state.records) {
    const indexedPath = state.sessions.find((session) => session.id === id)?.transcriptPath
    const tp = indexedPath || ((state.records.find((r) => r.transcriptPath) || state.trajectoryMeta || {})).transcriptPath
    if (tp) {
      try {
        const transcriptData = await api('/api/transcript?path=' + encodeURIComponent(tp))
        state.transcript = transcriptData.lines
        state.transcriptVersion = transcriptData.version || null
      } catch (e) {
        state.transcript = null
      }
    }
  }
  render()
  if (state.page || options.followTail || wasNearTail) timeline.scrollTop = timeline.scrollHeight
}

async function loadOlderTrajectory() {
  if (!state.page?.hasMore || state.page.before == null || state.current?.kind !== 'trajectory') return
  const timeline = $('timeline')
  const previousHeight = timeline.scrollHeight
  const id = state.current.id
  const data = await api('/api/trajectory/' + encodeURIComponent(id) + '?limit=' + TRAJECTORY_PAGE_SIZE + '&before=' + state.page.before)
  if (state.current?.id !== id) return
  state.records = [...data.records, ...(state.records || [])]
  state.page = data.page
  state.trajectoryVersion = data.version || state.trajectoryVersion
  render()
  timeline.scrollTop += timeline.scrollHeight - previousHeight
}

async function openTranscript(path) {
  if (state.current?.kind !== 'transcript' || state.current.path !== path) {
    state.selectedKey = null
    state.selectedItem = null
  }
  state.current = { kind: 'transcript', path }
  state.records = null
  state.trajectoryVersion = null
  try {
    const data = await api('/api/transcript?path=' + encodeURIComponent(path))
    state.transcript = data.lines
    state.transcriptVersion = data.version || null
  } catch (e) {
    state.transcript = null
  }
  render()
}

function sameVersion(left, right) {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
}

function activeTranscriptPath() {
  if (state.current?.kind === 'transcript') return state.current.path
  const indexedPath = state.current?.kind === 'trajectory' && state.sessions.find((session) => session.id === state.current.id)?.transcriptPath
  if (indexedPath) return indexedPath
  return (state.records?.find((record) => record.transcriptPath) || state.trajectoryMeta || {}).transcriptPath || null
}

async function refreshCurrent(options: { followTail?: boolean } = {}) {
  if (!state.current || state.refreshInFlight) return
  state.refreshInFlight = true
  try {
    if (state.current.kind === 'trajectory') {
      await openTrajectory(state.current.id, { followTail: options.followTail !== false })
    } else {
      await openTranscript(state.current.path)
      if (options.followTail !== false) $('timeline').scrollTop = $('timeline').scrollHeight
    }
  } finally {
    state.refreshInFlight = false
  }
}

async function pollCurrentVersion() {
  if (!state.current || state.refreshInFlight || document.visibilityState !== 'visible') return
  const timeline = $('timeline')
  const nearTail = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 120
  if (!nearTail) return
  const params = new URLSearchParams()
  if (state.current.kind === 'trajectory') params.set('id', state.current.id)
  const transcriptPath = state.merge ? activeTranscriptPath() : null
  if (transcriptPath) params.set('path', transcriptPath)
  if (![...params].length) return
  try {
    const versions = await api('/api/version?' + params)
    const trajectoryChanged = versions.trajectory && !sameVersion(versions.trajectory, state.trajectoryVersion)
    const transcriptChanged = versions.transcript && !sameVersion(versions.transcript, state.transcriptVersion)
    if (trajectoryChanged || transcriptChanged) await refreshCurrent({ followTail: true })
  } catch (error) {
    console.error('pollCurrentVersion failed', error)
  }
}

function buildPlain(records) {
  const hasTool = new Set(records.filter((r) => r.type === 'tool' && r.toolUseId).map((r) => r.toolUseId))
  const startByUse = new Map<string, { ts: number; tool: string }>(records.filter((r) => r.type === 'tool-start' && r.toolUseId).map((r) => [r.toolUseId, { ts: r.ts, tool: r.tool }]))
  const items: any[] = []
  for (const r of records) {
    if (r.type === 'tool-start') {
      if (hasTool.has(r.toolUseId)) continue
      items.push({ kind: 'tool', tool: r.tool, toolUseId: r.toolUseId, input: r.input, result: null, startTs: r.ts, incomplete: true, ts: r.ts })
    } else if (r.type === 'tool') {
      const st = startByUse.get(r.toolUseId)
      items.push({ kind: 'tool', tool: r.tool || (st && st.tool), toolUseId: r.toolUseId, input: r.input, result: r.result, startTs: st && st.ts, durationMs: st ? (r.ts - st.ts) : null, ts: r.ts })
    } else if (r.type === 'assistant') {
      items.push({ kind: 'assistant', text: r.text, ts: r.ts })
    } else if (r.type === 'usage') {
      items.push({ kind: 'usage', rec: r, ts: r.ts })
    } else if (r.type === 'permission') {
      items.push({ kind: 'permission', tool: r.tool, decision: r.decision, reason: r.reason, ts: r.ts })
    } else if (r.type === 'subagent-start' || r.type === 'subagent-end') {
      items.push({ kind: r.type, rec: r, ts: r.ts })
    } else if (r.type === 'turn-end') {
      items.push({ kind: 'turn-end', ts: r.ts })
    } else if (r.type === 'session-end') {
      items.push({ kind: 'session-end', rec: r, ts: r.ts })
    } else if (r.type === 'session') {
      items.push({ kind: 'session', rec: r, ts: r.ts })
    } else if (r.type === 'user') {
      items.push({ kind: 'user', text: r.text, ts: r.ts })
    } else {
      items.push({ kind: 'other', rec: r, ts: r.ts })
    }
  }
  return items
}

function buildSpine(lines, records) {
  const byUse = new Map()
  for (const r of records || []) {
    if (!r.toolUseId || (r.type !== 'tool-start' && r.type !== 'tool')) continue
    const slot = byUse.has(r.toolUseId) ? byUse.get(r.toolUseId) : {}
    if (r.type === 'tool-start') Object.assign(slot, { startTs: r.ts, tool: r.tool, input: r.input })
    else Object.assign(slot, { endTs: r.ts, tool: r.tool || slot.tool, result: r.result })
    byUse.set(r.toolUseId, slot)
  }
  const items: any[] = []
  const extra = (records || []).filter((r) => !['tool-start', 'tool', 'user', 'assistant'].includes(r.type))
  let lastTool: any = null
  for (const line of lines) {
    const lineTs = line.timestamp ? Date.parse(line.timestamp) : null
    if (line.type === 'system') {
      if (line.subtype === 'init') {
        const c = msgContent(line)
        items.push({ kind: 'system', text: Array.isArray(c) ? c.join('') : (typeof c === 'string' ? c : ''), ts: lineTs })
      }
    } else if (line.type === 'user') {
      const c = msgContent(line)
      // CC wraps tool_result as a user message; backfill the tool card instead
      // of rendering an empty "你" bubble.
      const block = Array.isArray(c) ? c.find((b) => b && b.type === 'tool_result') : null
      if (block) {
        if (lastTool && lastTool.toolUseId === block.tool_use_id) {
          lastTool.result = block.content
        } else {
          items.push({ kind: 'tool-result', text: textOf(block.content), isError: !!block.is_error, ts: lineTs })
        }
      } else {
        items.push({ kind: 'user', text: textOf(c), ts: lineTs })
      }
    } else if (line.type === 'assistant') {
      const blocks = Array.isArray(msgContent(line)) ? msgContent(line) : []
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (text.trim()) items.push({ kind: 'assistant', text, ts: lineTs })
      for (const b of blocks.filter((b) => b.type === 'tool_use')) {
        const t = byUse.get(b.id) || {}
        const item = { kind: 'tool', tool: b.name, toolUseId: b.id, input: b.input, result: t.result ?? null, startTs: t.startTs, durationMs: t.startTs && t.endTs ? (t.endTs - t.startTs) : null, transcript: true, ts: lineTs }
        items.push(item)
        lastTool = item
      }
    } else if (line.type === 'tool_use') {
      const t = byUse.get(line.id) || {}
      const item = { kind: 'tool', tool: line.name, toolUseId: line.id, input: line.input, result: t.result ?? null, startTs: t.startTs, durationMs: t.startTs && t.endTs ? (t.endTs - t.startTs) : null, transcript: true, ts: lineTs }
      items.push(item)
      lastTool = item
    } else if (line.type === 'tool_result') {
      const c = msgContent(line)
      const block = Array.isArray(c) ? c.find((b) => b && b.type === 'tool_result') : null
      const tuid = block ? block.tool_use_id : line.tool_use_id
      const tcontent = block ? block.content : line.content
      const isError = block ? !!block.is_error : !!line.is_error
      if (lastTool && lastTool.toolUseId === tuid) {
        lastTool.result = tcontent
      } else {
        items.push({ kind: 'tool-result', text: textOf(tcontent), isError, ts: lineTs })
      }
    } else if (line.type === 'summary') {
      items.push({ kind: 'system', text: '摘要：' + String(line.summary ?? '').slice(0, 400), ts: lineTs })
    }
  }
  for (const record of extra) {
    const projected = buildPlain([record])[0]
    if (!projected) continue
    const index = items.findIndex((item) => item.ts != null && item.ts > record.ts)
    if (index < 0) items.push(projected)
    else items.splice(index, 0, projected)
  }
  return items
}

function buildItems() {
  if (state.transcript && state.transcript.length && state.records) return buildSpine(state.transcript, state.records)
  if (state.transcript && state.transcript.length) return buildSpine(state.transcript, [])
  return buildPlain(state.records || [])
}

function pretty(v) {
  if (v == null) return '—'
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2) } catch (e) { return v }
  }
  try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) }
}

function oneLine(v, limit = 220) {
  const value = pretty(v).replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

function kindInfo(it) {
  const map = {
    user: ['USER', 'user'], assistant: ['ASSISTANT', 'assistant'], tool: ['TOOL', 'tool'],
    'tool-result': ['RESULT', 'tool'], permission: ['PERMISSION', 'permission'], usage: ['USAGE', 'system'],
    'subagent-start': ['SUBTOOL', 'subagent'], 'subagent-end': ['SUBTOOL', 'subagent'],
    session: ['SESSION', 'lifecycle'], 'session-end': ['SESSION', 'lifecycle'], system: ['SYSTEM', 'system'], other: ['EVENT', 'system'],
  }
  return map[it.kind] || [String(it.kind || 'EVENT').toUpperCase(), 'system']
}

function itemTitle(it) {
  switch (it.kind) {
    case 'user': return oneLine(it.text) || '(empty input)'
    case 'assistant': return oneLine(it.text) || '(tool call only)'
    case 'tool': return it.tool || 'unknown tool'
    case 'tool-result': return it.isError ? 'Tool result · error' : 'Tool result'
    case 'permission': return (it.tool || 'Tool') + ' · ' + (it.decision || 'pending')
    case 'usage': return 'Token usage'
    case 'subagent-start': return 'Subagent started'
    case 'subagent-end': return 'Subagent completed'
    case 'session': return it.rec?.cwd || 'Session started'
    case 'session-end': return 'Session ended'
    case 'system': return oneLine(it.text) || 'System event'
    default: return it.rec?.type || it.kind || 'Event'
  }
}

function itemPreview(it) {
  switch (it.kind) {
    case 'tool': return it.result != null ? oneLine(it.result) : oneLine(it.input)
    case 'tool-result': return oneLine(it.text)
    case 'permission': return it.reason || it.decision || ''
    case 'usage': return 'input ' + (it.rec?.inputTokens ?? 0) + ' · output ' + (it.rec?.outputTokens ?? 0)
    case 'subagent-start': return it.rec?.agentTranscriptPath || ''
    case 'subagent-end': return it.rec?.lastAssistantMessage || it.rec?.agentTranscriptPath || ''
    case 'session': return [it.rec?.model, it.rec?.source].filter(Boolean).join(' · ')
    case 'system': return fmtTs(it.ts)
    default: return it.toolUseId || fmtTs(it.ts)
  }
}

function itemDuration(it) {
  if (it.durationMs == null) return ''
  if (it.durationMs < 1000) return it.durationMs + ' ms'
  return (it.durationMs / 1000).toFixed(it.durationMs < 10000 ? 2 : 1) + ' s'
}

function itemKey(it, index) {
  return [it.kind, it.toolUseId || '', it.ts || it.startTs || '', index].join(':')
}

function selectItem(it, index, key = itemKey(it, index)) {
  state.selectedKey = key
  state.selectedItem = { it, index, key }
  document.querySelectorAll('.record-row.selected').forEach((row) => row.classList.remove('selected'))
  const row = document.querySelector('[data-record-key="' + CSS.escape(key) + '"]')
  if (row) row.classList.add('selected')
  renderInspector()
}

function renderItem(it, index) {
  if (it.kind === 'turn-end') {
    const row = div('turn-row')
    row.textContent = '回合结束'
    return row
  }
  const key = itemKey(it, index)
  const row = div('record-row' + (state.selectedKey === key ? ' selected' : ''))
  row.dataset.recordKey = key
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  const rail = div('rail')
  const [label, cls] = kindInfo(it)
  const tag = div('record-tag ' + cls)
  tag.textContent = label
  const primary = div('record-primary')
  primary.textContent = itemTitle(it)
  const secondary = div('record-secondary')
  secondary.textContent = itemPreview(it)
  const duration = div('record-duration')
  duration.textContent = itemDuration(it) || (it.ts ? new Date(it.ts).toLocaleTimeString('zh-CN', { hour12:false }) : '')
  row.append(rail, tag, primary, secondary, duration)
  row.onclick = () => selectItem(it, index, key)
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectItem(it, index, key) }
  }
  return row
}

function detailGrid(entries) {
  const grid = div('detail-grid')
  for (const [label, value] of entries) {
    const left = div('detail-label'); left.textContent = label
    const right = div('detail-value'); right.textContent = value == null || value === '' ? '—' : String(value)
    grid.append(left, right)
  }
  return grid
}

function inspectorPayload(it) {
  if (it.kind === 'tool') return it.input
  if (it.kind === 'user' || it.kind === 'assistant' || it.kind === 'tool-result' || it.kind === 'system') return it.text
  if (it.kind === 'permission') return { tool:it.tool, decision:it.decision, reason:it.reason }
  return it.rec || null
}

function inspectorResult(it) {
  if (it.kind === 'tool') return it.result
  if (it.kind === 'tool-result') return { content:it.text, isError:it.isError }
  if (it.kind === 'subagent-end') return it.rec?.lastAssistantMessage || null
  return null
}

function renderInspector() {
  const panel = $('inspector')
  if (!state.selectedItem) { panel.hidden = true; return }
  const { it, index } = state.selectedItem
  panel.hidden = false
  const [label, cls] = kindInfo(it)
  $('inspectorBadge').className = 'record-tag ' + cls
  $('inspectorBadge').textContent = label
  $('inspectorTitle').textContent = 'Turn ' + (index + 1) + ' · ' + itemTitle(it)
  const tabs = [
    ['summary', 'Summary'], ['payload', 'Payload'], ['result', 'Result'], ['schema', 'Schema'], ['timing', 'Timing'],
  ]
  $('inspectorTabs').innerHTML = ''
  for (const [key, text] of tabs) {
    const button = document.createElement('button')
    button.className = 'inspector-tab' + (state.inspectorTab === key ? ' active' : '')
    button.textContent = text
    button.onclick = () => { state.inspectorTab = key; renderInspector() }
    $('inspectorTabs').appendChild(button)
  }
  const body = $('inspectorBody')
  body.innerHTML = ''
  if (state.inspectorTab === 'summary') {
    body.appendChild(detailGrid([
      ['Hierarchy', label === 'TOOL' ? 'Assistant Message › Tool Call' : label],
      ['Status', it.incomplete ? 'Incomplete' : (it.isError ? 'Error' : 'Completed')],
      ['Name', itemTitle(it)],
      ['Tool use ID', it.toolUseId || '—'],
    ]))
    const payloadTitle = div('detail-section'); payloadTitle.textContent = 'Payload'
    const payload = document.createElement('pre'); payload.className = 'detail-pre'; payload.textContent = pretty(inspectorPayload(it))
    body.append(payloadTitle, payload)
    if (inspectorResult(it) != null) {
      const resultTitle = div('detail-section'); resultTitle.textContent = 'Result'
      const result = document.createElement('pre'); result.className = 'detail-pre'; result.textContent = pretty(inspectorResult(it))
      body.append(resultTitle, result)
    }
  } else if (state.inspectorTab === 'timing') {
    const started = it.startTs || it.ts
    const ended = it.startTs && it.durationMs != null ? it.startTs + it.durationMs : it.ts
    body.appendChild(detailGrid([
      ['Started', started ? new Date(started).toISOString() : '—'],
      ['Ended', ended ? new Date(ended).toISOString() : '—'],
      ['Duration', itemDuration(it) || '—'],
      ['Timing source', it.startTs ? 'Hook timestamps' : 'Session timestamps'],
    ]))
  } else if (state.inspectorTab === 'schema') {
    body.appendChild(detailGrid([['Schema', 'Schema unavailable']]))
  } else {
    const value = state.inspectorTab === 'payload' ? inspectorPayload(it) : inspectorResult(it)
    const pre = document.createElement('pre'); pre.className = 'detail-pre'; pre.textContent = pretty(value)
    body.appendChild(pre)
  }
}

function itemText(it) {
  try {
    return JSON.stringify(it)
  } catch (e) {
    return ''
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return ms + ' ms'
  const seconds = ms / 1000
  if (seconds < 60) return seconds.toFixed(seconds < 10 ? 2 : 1) + ' s'
  const minutes = Math.floor(seconds / 60)
  return minutes + 'm ' + Math.round(seconds % 60) + 's'
}

type OverviewEntry = { it: any; index: number; key: string }

function renderOverview(entries: OverviewEntry[]) {
  const overview = $('overview')
  overview.innerHTML = ''
  const timed = entries.filter(({ it }) => Number.isFinite(it.startTs || it.ts))
  const starts = timed.map(({ it }) => it.startTs || it.ts)
  const ends = timed.map(({ it }) => (it.startTs || it.ts) + Math.max(0, it.durationMs || 0))
  const minTs = starts.length ? Math.min(...starts) : 0
  const maxTs = ends.length ? Math.max(...ends) : minTs
  const span = Math.max(1, maxTs - minTs)
  const lanes: Array<[string, string, (entry: OverviewEntry) => boolean]> = [
    ['Input', 'input', ({ it }) => it.kind === 'user'],
    ['Model', 'model', ({ it }) => it.kind === 'assistant'],
    ['Tools', 'tools', ({ it }) => ['tool', 'permission', 'subagent-start', 'subagent-end'].includes(it.kind)],
  ]
  for (const [label, cls, accepts] of lanes) {
    const labelEl = div('overview-label'); labelEl.textContent = label
    const track = div('overview-track')
    for (const entry of timed.filter(accepts)) {
      const start = entry.it.startTs || entry.it.ts
      const left = ((start - minTs) / span) * 100
      const duration = Math.max(entry.it.durationMs || 0, span * .0025)
      const width = Math.max(.25, Math.min(100 - left, (duration / span) * 100))
      const bar = div('overview-bar ' + cls)
      bar.style.left = left + '%'
      bar.style.width = width + '%'
      bar.title = kindInfo(entry.it)[0] + ' · ' + itemTitle(entry.it)
      bar.onclick = () => {
        selectItem(entry.it, entry.index, entry.key)
        document.querySelector('[data-record-key="' + CSS.escape(entry.key) + '"]')?.scrollIntoView({ block:'center' })
      }
      track.appendChild(bar)
    }
    overview.append(labelEl, track)
  }
  const allTimed = entries.map(({ it }) => it.startTs || it.ts).filter(Number.isFinite)
  $('durationMetric').textContent = 'Duration ' + (allTimed.length ? formatElapsed(Math.max(...allTimed) - Math.min(...allTimed)) : '—')
  $('turnMetric').textContent = 'Turns ' + entries.filter(({ it }) => it.kind === 'turn-end').length
  $('callMetric').textContent = 'Calls ' + entries.filter(({ it }) => it.kind === 'tool').length
}

function render() {
  const tl = $('timeline')
  tl.innerHTML = ''
  if (!state.current) {
    renderOverview([])
    state.selectedItem = null
    renderInspector()
    tl.appendChild(div('empty', '从左侧选择一个会话；或先运行 <code>npm run demo</code> 生成示例数据。'))
    return
  }
  const items = buildItems()
  const q = state.search.trim().toLowerCase()
  const visible = items.map((it, index) => ({ it, index, key:itemKey(it, index) }))
    .filter(({ it }) => !q || itemText(it).toLowerCase().includes(q))
  renderOverview(visible)
  if (state.selectedKey) {
    const selected = visible.find(({ key }) => key === state.selectedKey)
    if (selected) state.selectedItem = selected
    else {
      state.selectedKey = null
      state.selectedItem = null
    }
  }
  renderInspector()
  const frag = document.createDocumentFragment()
  let shown = 0
  if (state.page?.hasMore) {
    const button = document.createElement('button')
    button.className = 'load-more'
    button.textContent = '加载更早记录（已加载 ' + state.records.length + ' / ' + state.page.total + '）'
    button.onclick = async () => {
      button.disabled = true
      button.textContent = '正在加载…'
      try { await loadOlderTrajectory() } catch (e) {
        button.disabled = false
        button.textContent = '加载失败，点击重试'
        console.error('loadOlderTrajectory failed', e)
      }
    }
    frag.appendChild(button)
  }
  for (const { it, index } of visible) {
    const el = renderItem(it, index)
    if (el) {
      frag.appendChild(el)
      shown++
    }
  }
  if (!shown) tl.appendChild(div('empty', '没有匹配的记录。'))
  else tl.appendChild(frag)
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
$('globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => globalSearch(e.target.value), 250)
})
async function globalSearch(q) {
  const ul = $('searchResults')
  if (!q.trim()) { ul.hidden = true; ul.innerHTML = ''; return }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q))
    ul.hidden = false
    if (data.error) { ul.innerHTML = '<li class="hint">' + esc(data.error) + '</li>'; return }
    ul.innerHTML = ''
    if (!data.rows.length) { ul.innerHTML = '<li class="hint">无匹配</li>'; return }
    for (const row of data.rows) {
      const li = document.createElement('li')
      li.innerHTML = '<div><span class="badge end">' + esc(row.type || '?') + '</span> <code>' + esc(row.tool || String(row.sessionId).slice(0, 16)) + '</code></div><div class="t">' + esc(String(row.snippet || '').slice(0, 90)) + '</div>'
      li.onclick = () => { openTrajectory(row.sessionId) }
      ul.appendChild(li)
    }
  } catch (e) {
    console.error('globalSearch failed', e)
  }
}

$('statsBtn').addEventListener('click', async () => {
  const panel = $('statsPanel')
  const body = $('statsBody')
  panel.hidden = false
  panel.open = true
  try {
    const data = await api('/api/stats')
    if (data.error) { body.innerHTML = '<div class="hint">' + esc(data.error) + '</div>'; return }
    let h = '<table><tr><th>会话</th><th>记录</th><th>时长(s)</th><th>提示</th><th>工具</th><th>拒绝</th><th>子代理</th></tr>'
    for (const s of data.sessions) {
      h += '<tr><td><code>' + esc(String(s.id).slice(0, 14)) + '</code></td><td>' + s.records + '</td><td>' + Math.round(s.duration_s || 0) + '</td><td>' + (s.prompts || 0) + '</td><td>' + (s.tools || 0) + '</td><td>' + (s.denials || 0) + '</td><td>' + (s.subagents || 0) + '</td></tr>'
    }
    h += '</table>'
    if (data.topTools && data.topTools.length) {
      h += '<div class="extra-title">高频工具</div>'
      for (const t of data.topTools) h += '<div class="t">' + esc(t.tool) + ' × ' + t.calls + '</div>'
    }
    body.innerHTML = h
  } catch (e) {
    body.innerHTML = '<div class="hint">加载失败：' + esc(String(e)) + '</div>'
  }
})

$('search').addEventListener('input', (e) => { state.search = e.target.value; render() })
$('inspectorClose').addEventListener('click', () => {
  state.selectedKey = null
  state.selectedItem = null
  document.querySelectorAll('.record-row.selected').forEach((row) => row.classList.remove('selected'))
  renderInspector()
})
$('merge').addEventListener('change', (e) => {
  state.merge = e.target.checked
  if (state.current && state.current.kind === 'trajectory') openTrajectory(state.current.id)
  else render()
})
$('refresh').addEventListener('click', async () => {
  const button = $('refresh')
  button.disabled = true
  try {
    await loadSessions()
    await refreshCurrent({ followTail: true })
  } finally {
    button.disabled = false
  }
})
loadSessions()
setInterval(pollCurrentVersion, 3000)

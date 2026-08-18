#!/usr/bin/env node
// Generate a realistic sample trajectory so the viewer can be tried without a real session.
//   npm run demo
// Importable (generateDemo) so the CI smoke test can reuse it.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendRecord, TRAJECTORY_ROOT } from '../lib/record.js'

/** Append a realistic sample trajectory for one session. */
export function generateDemo(id = 'demo') {
  const t0 = Date.now() - 10 * 60 * 1000
  appendRecord(id, { type: 'session', ts: t0, transcriptPath: '', cwd: 'C:/projects/example', source: 'startup', model: 'claude-sonnet-4-5' })
  appendRecord(id, { type: 'user', ts: t0 + 1000, text: '重构 src/utils.ts 的日期处理，拆成独立模块' })
  appendRecord(id, { type: 'tool-start', ts: t0 + 4000, toolUseId: 'toolu_01A', tool: 'Read', input: '{"file_path":"src/utils.ts"}' })
  appendRecord(id, { type: 'tool', ts: t0 + 5200, toolUseId: 'toolu_01A', tool: 'Read', input: '{"file_path":"src/utils.ts"}', result: '// 日期工具函数（文件内容预览，已截断）\nfunction pad(n) { return String(n).padStart(2, "0") }\n...' })
  appendRecord(id, { type: 'permission', ts: t0 + 6000, toolUseId: 'toolu_01B', tool: 'Write', decision: 'denied', reason: '用户拒绝了直接改写原文件' })
  appendRecord(id, { type: 'user', ts: t0 + 6500, text: '那就先只建新文件，别动原文件' })
  appendRecord(id, { type: 'tool-start', ts: t0 + 9000, toolUseId: 'toolu_02A', tool: 'Write', input: '{"file_path":"src/dates.ts","content":"export function formatDate(d) { ... }"}' })
  appendRecord(id, { type: 'tool', ts: t0 + 9800, toolUseId: 'toolu_02A', tool: 'Write', input: '{"file_path":"src/dates.ts"}', result: '文件已写入' })
  appendRecord(id, { type: 'tool-start', ts: t0 + 10000, toolUseId: 'toolu_02B', tool: 'Bash', input: '{"command":"pnpm test"}' })
  appendRecord(id, { type: 'tool', ts: t0 + 42000, toolUseId: 'toolu_02B', tool: 'Bash', input: '{"command":"pnpm test"}', result: '✓ 12 tests passed' })
  appendRecord(id, { type: 'assistant', ts: t0 + 42500, text: '测试全部通过。我顺带检查了其他调用点，确认没有其他地方依赖旧的日期格式。' })
  appendRecord(id, { type: 'usage', ts: t0 + 43000, kind: 'cumulative', inputTokens: 18423, outputTokens: 5210, cacheReadInputTokens: 9021, cacheCreationInputTokens: 0 })
  appendRecord(id, { type: 'subagent-start', ts: t0 + 44000, agentType: 'general-purpose', transcriptPath: '' })
  appendRecord(id, { type: 'subagent-end', ts: t0 + 120000, agentType: 'general-purpose', agentTranscriptPath: '', lastAssistantMessage: '已检查其余调用点' })
  appendRecord(id, { type: 'turn-end', ts: t0 + 121000, lastAssistantMessage: '重构完成，测试通过。' })
  appendRecord(id, { type: 'session-end', ts: t0 + 122000 })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  generateDemo()
  console.log('demo trajectory written to', TRAJECTORY_ROOT + '/demo.jsonl')
  console.log('now run: trajectory start')
}

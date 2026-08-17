#!/usr/bin/env node
/**
 * Copy the plugin into ~/.claude/plugins/agent-trajectory and rewrite hook commands
 * to absolute paths. This sidesteps cases where ${CLAUDE_PLUGIN_ROOT} is not
 * injected (some versions/platforms, notably SessionStart — see
 * anthropics/claude-code#27145) and is the most reliable form on Windows.
 *
 *   node scripts/install.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PLUGIN_ROOT } from '../lib/record.mjs'

const DEST = join(homedir(), '.claude', 'plugins', 'agent-trajectory')
mkdirSync(DEST, { recursive: true })

for (const sub of ['hooks', 'lib', 'viewer', 'scripts']) {
  cpSync(join(PLUGIN_ROOT, sub), join(DEST, sub), { recursive: true })
}

const raw = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8'))
const destAbs = DEST.replace(/\\/g, '/')
for (const groups of Object.values(raw.hooks)) {
  for (const group of groups) {
    for (const h of group.hooks) {
      h.command = h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, destAbs)
    }
  }
}
writeFileSync(join(DEST, 'plugin.json'), JSON.stringify(raw, null, 2) + '\n')

console.log('installed to', DEST)
console.log('next steps:')
console.log('  1. 重启 claude（hooks 在启动时加载），运行 /plugin 确认 trajectory 已启用')
console.log('  2. 跑一个会话，然后执行: node ' + destAbs + '/viewer/serve.mjs')
console.log('  3. 浏览器打开 http://127.0.0.1:8611')

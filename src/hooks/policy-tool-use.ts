#!/usr/bin/env node
// PreToolUse POLICY hook: makes a decision (deny/ask/allow) and logs it.
//
// A pure recorder cannot see "denied" or "asked" tools — the decision IS the
// hook's exit code. This hook actually decides, then records the decision as
// a {type:'permission'} record in the same trajectory log.
//
// Policy config (optional): ~/.claude/trajectory-policy.json
//   {
//     "deny": [ { "tool": "Bash", "inputContains": ["rm -rf"] } ],
//     "ask":  [ { "tool": "Write", "inputContains": [".env"] } ]
//   }
// deny wins over ask; an empty/missing config allows everything.
// Exit-code contract: 0 allow, 1 ask, 2 deny. On any internal error the hook
// fails OPEN (exit 0) so a policy bug can never take the agent down.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStdinJson, redact, truncate, appendRecord, safeSessionId } from '../lib/record.js'

const CONFIG_PATH = process.env.TRAJECTORY_POLICY || join(homedir(), '.claude', 'trajectory-policy.json')

function loadPolicy() {
  if (!existsSync(CONFIG_PATH)) return { deny: [], ask: [] }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { deny: [], ask: [] }
  }
}

function matchRule(rule, tool, input) {
  if (rule.tool && rule.tool !== tool) return false
  if (rule.inputContains && Array.isArray(rule.inputContains)) {
    const s = JSON.stringify(input ?? '')
    if (!rule.inputContains.some((sub) => s.includes(sub))) return false
  }
  return true
}

function decide(policy, tool, input) {
  if (Array.isArray(policy.deny) && policy.deny.some((r) => matchRule(r, tool, input))) {
    return { decision: 'denied', reason: 'deny rule matched' }
  }
  if (Array.isArray(policy.ask) && policy.ask.some((r) => matchRule(r, tool, input))) {
    return { decision: 'asked', reason: 'ask rule matched' }
  }
  return { decision: 'allowed', reason: '' }
}

try {
  const p = readStdinJson()
  const { decision, reason } = decide(loadPolicy(), p.tool_name, p.tool_input)
  if (p.session_id) {
    try {
      appendRecord(safeSessionId(p.session_id), {
        type: 'permission',
        toolUseId: p.tool_use_id,
        tool: p.tool_name,
        decision,
        reason,
        inputPreview: truncate(redact(p.tool_input), 500),
      })
    } catch {
      // recording must not affect the decision path
    }
  }
  if (decision === 'denied') {
    process.stdout.write(JSON.stringify({ reason }) + '\n')
    process.exit(2)
  }
  if (decision === 'asked') process.exit(1)
  process.exit(0)
} catch {
  process.exit(0)
}

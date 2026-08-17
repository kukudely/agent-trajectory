#!/usr/bin/env node
// PreToolUse hook: record tool invocation start.
// NOTE: an observer cannot see "denied"/"asked" tools — only a hook that
// actually decides (exit 2 / exit 1) can. This recorder always allows; see
// README "记录权限决策" for a policy-hook variant.
import { runHook, redact, truncate, LIMIT_INPUT } from '../lib/record.mjs'

runHook('pre-tool-use', (p) => ({
  type: 'tool-start',
  toolUseId: p.tool_use_id,
  tool: p.tool_name,
  input: truncate(redact(p.tool_input), LIMIT_INPUT),
  permissionMode: p.permission_mode,
}))

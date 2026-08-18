#!/usr/bin/env node
// PostToolUse hook: record tool completion with a result preview.
import { runHook, redact, truncate, LIMIT_INPUT, LIMIT_RESULT } from '../lib/record.js'

runHook('post-tool-use', (p) => ({
  type: 'tool',
  toolUseId: p.tool_use_id,
  tool: p.tool_name,
  input: truncate(redact(p.tool_input), LIMIT_INPUT),
  result: truncate(redact(p.tool_response), LIMIT_RESULT),
  transcriptPath: p.transcript_path ?? '',
}))

#!/usr/bin/env node
// SubagentStop hook: record subagent completion.
import { runHook, truncate, LIMIT_RESULT } from '../lib/record.mjs'

runHook('subagent-stop', (p) => ({
  type: 'subagent-end',
  agentType: p.agent_type,
  agentTranscriptPath: p.agent_transcript_path,
  lastAssistantMessage: truncate(p.last_assistant_message, LIMIT_RESULT),
}))

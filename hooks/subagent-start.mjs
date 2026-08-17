#!/usr/bin/env node
// SubagentStart hook: record subagent spawn.
import { runHook } from '../lib/record.mjs'

runHook('subagent-start', (p) => ({
  type: 'subagent-start',
  agentType: p.agent_type,
  transcriptPath: p.transcript_path ?? '',
}))

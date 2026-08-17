#!/usr/bin/env node
// SessionStart hook: record session metadata.
import { runHook, truncate } from '../lib/record.mjs'

runHook('session-start', (p) => ({
  type: 'session',
  transcriptPath: p.transcript_path ?? '',
  cwd: p.cwd ?? '',
  source: p.source,
  model: p.model,
  agentType: p.agent_type,
  sessionTitle: truncate(p.session_title ?? '', 200),
  permissionMode: p.permission_mode,
}))

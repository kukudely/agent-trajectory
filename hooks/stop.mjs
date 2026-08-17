#!/usr/bin/env node
// Stop hook: record the end of an agent turn.
import { runHook, truncate, LIMIT_RESULT } from '../lib/record.mjs'

runHook('stop', (p) => ({
  type: 'turn-end',
  lastAssistantMessage: truncate(p.last_assistant_message, LIMIT_RESULT),
  backgroundTasks: p.background_tasks,
  transcriptPath: p.transcript_path ?? '',
}))

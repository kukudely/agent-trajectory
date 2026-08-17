#!/usr/bin/env node
// UserPromptSubmit hook: record each user prompt.
import { runHook, truncate, LIMIT_PROMPT } from '../lib/record.mjs'

runHook('user-prompt-submit', (p) => ({
  type: 'user',
  promptId: p.prompt_id,
  text: truncate(p.prompt, LIMIT_PROMPT),
  transcriptPath: p.transcript_path ?? '',
}))

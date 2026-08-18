#!/usr/bin/env node
// SessionEnd hook: record session close.
import { runHook } from '../lib/record.js'

runHook('session-end', () => ({
  type: 'session-end',
}))

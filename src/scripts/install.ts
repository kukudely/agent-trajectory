#!/usr/bin/env node
/** Backward-compatible alias for the former trajectory-install command. */
import { main } from './cli.js'

await main(['install'])

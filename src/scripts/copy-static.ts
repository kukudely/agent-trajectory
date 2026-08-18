#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const viewerOut = join(root, 'dist', 'viewer')
mkdirSync(viewerOut, { recursive: true })
copyFileSync(join(root, 'viewer', 'index.html'), join(viewerOut, 'index.html'))
console.log('viewer static assets copied')

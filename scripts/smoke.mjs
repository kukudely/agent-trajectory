#!/usr/bin/env node
// Self-contained smoke test for CI (npm test): demo data -> SQLite projection ->
// viewer server -> API probes. No Claude Code or external services required.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), 'trajectory-smoke-'))

function assert(cond, msg) {
  if (!cond) throw new Error('smoke failed: ' + msg)
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('timed out waiting for server')
}

try {
  process.env.TRAJECTORY_ROOT = tmp
  process.env.TRANSCRIPT_ROOT = join(tmp, 'projects')

  // 1. demo data
  const { generateDemo } = await import(pathToFileURL(resolve(join(ROOT, 'scripts/demo.mjs'))).href)
  generateDemo('demo')

  // 2. SQLite projection
  execFileSync(process.execPath, [join(ROOT, 'scripts/project-sqlite.mjs'), '--db', join(tmp, 'trajectory.db')], {
    stdio: 'inherit',
    env: process.env,
  })

  // 3. viewer server + API probes
  const port = 8900 + Math.floor(Math.random() * 100)
  const server = spawn(process.execPath, [join(ROOT, 'viewer/serve.mjs'), String(port)], { stdio: 'inherit', env: process.env })
  try {
    await waitFor(() => fetch('http://127.0.0.1:' + port + '/api/sessions').then((r) => r.ok), 10_000)
    const sessions = await (await fetch('http://127.0.0.1:' + port + '/api/sessions')).json()
    assert(Array.isArray(sessions) && sessions.length >= 1, 'sessions list empty')

    const traj = await (await fetch('http://127.0.0.1:' + port + '/api/trajectory/demo')).json()
    assert(traj.records && traj.records.length >= 10, 'trajectory records missing')

    const stats = await (await fetch('http://127.0.0.1:' + port + '/api/stats')).json()
    assert(stats.sessions && stats.sessions.length >= 1, 'stats sessions empty')
    assert(stats.topTools && stats.topTools.length >= 1, 'top tools empty')

    const search = await (await fetch('http://127.0.0.1:' + port + '/api/search?q=' + encodeURIComponent('重构'))).json()
    assert(search.rows && search.rows.length >= 1, 'search found nothing')

    console.log('smoke OK: ' + sessions.length + ' session, ' + traj.records.length + ' records, ' + stats.topTools.length + ' top tools, search hits ' + search.rows.length)
  } finally {
    if (server && server.exitCode === null) {
      await new Promise((res) => {
        server.once('exit', res)
        server.kill()
        setTimeout(res, 2000) // Windows kill is async; do not leak the handle
      })
    }
  }
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  } catch (e) {
    console.warn('temp cleanup failed (ignored):', e.message)
  }
}

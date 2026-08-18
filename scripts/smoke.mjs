#!/usr/bin/env node
// Self-contained smoke test for CI (npm test): demo data -> SQLite projection ->
// viewer server -> API probes. No Claude Code or external services required.
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), 'trajectory-smoke-'))

function assert(cond, msg) {
  if (!cond) throw new Error('smoke failed: ' + msg)
}

function runHook(script, payload, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'ignore', 'pipe'], env })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`hook exited ${code}: ${stderr}`))
    })
    child.stdin.end(JSON.stringify(payload))
  })
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
  const { appendRecord, loadTrajectory, trajectoryPath, truncate, TRAJECTORY_SCHEMA_VERSION } =
    await import(pathToFileURL(resolve(join(ROOT, 'lib/record.mjs'))).href)
  assert(truncate(undefined, 20) === '' && truncate(null, 20) === '', 'truncate does not accept missing hook fields')
  generateDemo('demo')
  const demoRecords = loadTrajectory('demo')
  assert(demoRecords.every((record) => record.schemaVersion === TRAJECTORY_SCHEMA_VERSION), 'schema version missing')
  assert(demoRecords.every((record, index) => record.seq === index + 1), 'demo sequence is not contiguous')

  // 1a. a final partial JSON write is ignored by readers and repaired by the next writer
  const tornRoot = join(tmp, 'torn-root')
  appendRecord('torn', { type: 'session' }, { root: tornRoot })
  appendFileSync(trajectoryPath('torn', tornRoot), '{"seq":2,"type":"broken"', 'utf8')
  assert(loadTrajectory('torn', { root: tornRoot }).length === 1, 'torn tail was not ignored')
  appendRecord('torn', { type: 'session-end' }, { root: tornRoot })
  const repaired = loadTrajectory('torn', { root: tornRoot })
  assert(repaired.length === 2 && repaired[1].seq === 2, 'torn tail was not repaired before append')

  // A valid final JSON line without a newline must stay separate from the next append.
  const noNewlineRoot = join(tmp, 'no-newline-root')
  appendRecord('no-newline', { type: 'session' }, { root: noNewlineRoot })
  const noNewlineFile = trajectoryPath('no-newline', noNewlineRoot)
  const firstLine = loadTrajectory('no-newline', { root: noNewlineRoot })[0]
  writeFileSync(noNewlineFile, JSON.stringify(firstLine))
  appendRecord('no-newline', { type: 'session-end' }, { root: noNewlineRoot })
  assert(loadTrajectory('no-newline', { root: noNewlineRoot }).length === 2, 'newline-less valid tail was joined')

  // 1b. --out must win over the environment default
  const collectorRoot = join(tmp, 'collector-root')
  const ignoredRoot = join(tmp, 'ignored-root')
  const streamFile = join(tmp, 'stream.log')
  writeFileSync(streamFile, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'collector-out', cwd: 'C:/tmp', model: 'test' }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n') + '\n')
  execFileSync(process.execPath, [join(ROOT, 'scripts/collect-stream-json.mjs'), '--file', streamFile, '--out', collectorRoot], {
    stdio: 'inherit',
    env: { ...process.env, TRAJECTORY_ROOT: ignoredRoot },
  })
  assert(existsSync(trajectoryPath('collector-out', collectorRoot)), 'collector ignored --out')
  assert(!existsSync(trajectoryPath('collector-out', ignoredRoot)), 'collector wrote to environment root instead of --out')

  // 1c. independent hook processes must serialize seq assignment per session
  const concurrentRoot = join(tmp, 'concurrent-root')
  const concurrentEnv = { ...process.env, TRAJECTORY_ROOT: concurrentRoot }
  await Promise.all(Array.from({ length: 12 }, (_, index) => runHook(
    join(ROOT, 'hooks/pre-tool-use.mjs'),
    { session_id: 'concurrent', tool_use_id: `tool-${index}`, tool_name: 'Read', tool_input: { index } },
    concurrentEnv,
  )))
  const concurrent = loadTrajectory('concurrent', { root: concurrentRoot })
  assert(concurrent.length === 12, 'concurrent hook records were lost')
  assert(concurrent.every((record, index) => record.seq === index + 1), 'concurrent sequence is not contiguous')

  // 2. SQLite projection
  execFileSync(process.execPath, [join(ROOT, 'scripts/project-sqlite.mjs'), '--db', join(tmp, 'trajectory.db')], {
    stdio: 'inherit',
    env: process.env,
  })
  const unchangedProjection = execFileSync(process.execPath, [join(ROOT, 'scripts/project-sqlite.mjs'), '--db', join(tmp, 'trajectory.db')], {
    encoding: 'utf8',
    env: process.env,
  })
  assert(unchangedProjection.includes('indexed 0 changed sessions'), 'unchanged SQLite projection was rebuilt')

  // 3. viewer server + API probes
  const port = 8900 + Math.floor(Math.random() * 100)
  const server = spawn(process.execPath, [join(ROOT, 'viewer/serve.mjs'), String(port)], { stdio: 'inherit', env: process.env })
  try {
    await waitFor(() => fetch('http://127.0.0.1:' + port + '/api/sessions').then((r) => r.ok), 10_000)
    const sessions = await (await fetch('http://127.0.0.1:' + port + '/api/sessions')).json()
    assert(Array.isArray(sessions) && sessions.length >= 1, 'sessions list empty')

    const traj = await (await fetch('http://127.0.0.1:' + port + '/api/trajectory/demo')).json()
    assert(traj.records && traj.records.length >= 10, 'trajectory records missing')
    assert(traj.version?.mtimeMs && traj.version?.size, 'trajectory version missing')
    const version = await (await fetch('http://127.0.0.1:' + port + '/api/version?id=demo')).json()
    assert(version.trajectory?.mtimeMs === traj.version.mtimeMs, 'trajectory version endpoint is inconsistent')

    const page1 = await (await fetch('http://127.0.0.1:' + port + '/api/trajectory/demo?limit=5')).json()
    assert(page1.records.length === 5 && page1.page.total === traj.records.length, 'trajectory tail page is invalid')
    assert(page1.page.hasMore && page1.page.before === page1.records[0].seq, 'trajectory page cursor is invalid')
    const page2 = await (await fetch('http://127.0.0.1:' + port + '/api/trajectory/demo?limit=5&before=' + page1.page.before)).json()
    assert(page2.records.length === 5, 'older trajectory page is invalid')
    assert(!page2.records.some((record) => page1.records.some((newer) => newer.seq === record.seq)), 'trajectory pages overlap')
    const invalidPage = await fetch('http://127.0.0.1:' + port + '/api/trajectory/demo?limit=0')
    assert(invalidPage.status === 400, 'invalid trajectory page limit was accepted')

    const stats = await (await fetch('http://127.0.0.1:' + port + '/api/stats')).json()
    assert(stats.sessions && stats.sessions.length >= 1, 'stats sessions empty')
    assert(stats.topTools && stats.topTools.length >= 1, 'top tools empty')

    const search = await (await fetch('http://127.0.0.1:' + port + '/api/search?q=' + encodeURIComponent('重构'))).json()
    assert(search.rows && search.rows.length >= 1, 'search found nothing')
    assert(search.engine === 'fts5', 'search did not use FTS5')
    const substringSearch = await (await fetch('http://127.0.0.1:' + port + '/api/search?q=' + encodeURIComponent('构 src'))).json()
    assert(substringSearch.rows.length >= 1 && substringSearch.engine === 'like-fallback', 'substring search fallback failed')

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

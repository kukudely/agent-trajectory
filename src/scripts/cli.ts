#!/usr/bin/env node
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ROOT } from '../lib/record.js'

const PACKAGE = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const MARKETPLACE = 'agent-trajectory'
const PLUGIN_ID = `agent-trajectory@${MARKETPLACE}`
const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const STATE_DIR = process.env.TRAJECTORY_STATE_DIR || join(CLAUDE_CONFIG, 'agent-trajectory')
const STATE_FILE = join(STATE_DIR, 'viewer.json')
const LOG_FILE = join(STATE_DIR, 'viewer.log')
const VIEWER_SCRIPT = join(PLUGIN_ROOT, 'dist', 'viewer', 'serve.js')

function output(message = '') {
  process.stdout.write(String(message) + '\n')
}

function fail(message): never {
  throw new Error(message)
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('-')) fail(`${name} requires a value`)
  return args[index + 1]
}

function portOf(args) {
  const port = Number(option(args, '--port', process.env.PORT || 8611))
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${port}`)
  return port
}

let cachedClaudeInvocation: { command: string; prefix: string[] } | null = null
function claudeInvocation() {
  if (cachedClaudeInvocation) return cachedClaudeInvocation
  if (process.platform !== 'win32') return { command: 'claude', prefix: [] }
  for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const native = join(dir, 'claude.exe')
    if (existsSync(native)) return (cachedClaudeInvocation = { command: native, prefix: [] })
    const npmCli = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (existsSync(npmCli)) return (cachedClaudeInvocation = { command: process.execPath, prefix: [npmCli] })
  }
  fail('Claude Code CLI was not found on PATH')
}

type ClaudeRunOptions = { capture?: boolean; allowFailure?: boolean; cwd?: string }

function runClaude(args: string[], { capture = false, allowFailure = false, cwd }: ClaudeRunOptions = {}) {
  const invocation = claudeInvocation()
  const result = spawnSync(invocation.command, [...invocation.prefix, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    cwd,
  })
  if (result.error) fail(`cannot run Claude Code CLI: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : ''
    fail(`claude ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function parseJsonOutput(text, label) {
  const source = String(text || '').trim()
  for (const token of ['[', '{']) {
    const index = source.indexOf(token)
    if (index >= 0) {
      try { return JSON.parse(source.slice(index)) } catch { /* try the next token */ }
    }
  }
  fail(`unable to parse ${label} JSON output`)
}

function claudeJson(args, label): any {
  const result = runClaude(args, { capture: true })
  return parseJsonOutput(result.stdout, label)
}

function isLegacyTrajectoryCommand(command) {
  const normalized = String(command || '').replaceAll('\\', '/').toLowerCase()
  return normalized.includes('/.claude/plugins/agent-trajectory/hooks/') ||
    normalized.includes('/.claude/plugins/trajectory/hooks/')
}

export function removeLegacyHooks(settings) {
  const next = structuredClone(settings || {})
  let removed = 0
  if (!next.hooks || typeof next.hooks !== 'object') return { settings: next, removed }
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue
    const keptGroups: any[] = []
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) { keptGroups.push(group); continue }
      const hooks = group.hooks.filter((hook) => {
        const legacy = hook?.type === 'command' && isLegacyTrajectoryCommand(hook.command)
        if (legacy) removed++
        return !legacy
      })
      if (hooks.length) keptGroups.push({ ...group, hooks })
    }
    if (keptGroups.length) next.hooks[event] = keptGroups
    else delete next.hooks[event]
  }
  if (!Object.keys(next.hooks).length) delete next.hooks
  return { settings: next, removed }
}

function migrateLegacySettings() {
  const settingsPath = join(CLAUDE_CONFIG, 'settings.json')
  if (!existsSync(settingsPath)) return 0
  const current = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const migrated = removeLegacyHooks(current)
  if (!migrated.removed) return 0
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backup = `${settingsPath}.bak-agent-trajectory-${stamp}`
  copyFileSync(settingsPath, backup)
  writeFileSync(settingsPath, JSON.stringify(migrated.settings, null, 2) + '\n')
  output(`migrated ${migrated.removed} legacy hook entries (backup: ${backup})`)
  return migrated.removed
}

async function viewerHealth(port, timeoutMs = 900) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const data = await response.json()
    return data?.app === 'agent-trajectory' ? data : null
  } catch {
    return null
  }
}

async function waitForViewer(port, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await viewerHealth(port)
    if (health) return health
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  return null
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`
  let command
  let args
  if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe'
    args = ['/d', '/s', '/c', 'start', '', url]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}

function readViewerState() {
  if (!existsSync(STATE_FILE)) return null
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function startViewer(args) {
  const port = portOf(args)
  const existing = await viewerHealth(port)
  if (existing) {
    output(`viewer already running: http://127.0.0.1:${port}`)
    if (!args.includes('--no-open')) openBrowser(port)
    return
  }
  mkdirSync(STATE_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [VIEWER_SCRIPT, String(port)], {
    cwd: PLUGIN_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port) },
  })
  child.unref()
  closeSync(logFd)
  const health = await waitForViewer(port)
  if (!health) {
    if (child.pid) try { process.kill(child.pid) } catch { /* already exited */ }
    fail(`viewer did not start; inspect ${LOG_FILE}`)
  }
  writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString(), version: PACKAGE.version }, null, 2) + '\n')
  output(`viewer started (pid ${child.pid}): http://127.0.0.1:${port}`)
  if (!args.includes('--no-open')) openBrowser(port)
}

async function serveViewer(args) {
  const port = portOf(args)
  const child = spawn(process.execPath, [VIEWER_SCRIPT, String(port)], {
    cwd: PLUGIN_ROOT,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  })
  if (args.includes('--open')) {
    if (await waitForViewer(port)) openBrowser(port)
  }
  const code = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0)))
  })
  process.exitCode = code
}

async function stopViewer(args: string[] = []) {
  const state = readViewerState()
  if (!state) {
    output('viewer is not managed by trajectory (no state file)')
    return
  }
  if (pidAlive(state.pid)) {
    const health = await viewerHealth(state.port)
    if (!health && !args.includes('--force')) {
      fail(`pid ${state.pid} is alive but does not identify as agent-trajectory; refusing to stop it (use --force if you verified the process)`)
    }
    process.kill(state.pid, 'SIGTERM')
    const deadline = Date.now() + 5_000
    while (pidAlive(state.pid) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    if (pidAlive(state.pid)) fail(`viewer pid ${state.pid} did not stop`)
  }
  try { unlinkSync(STATE_FILE) } catch { /* already removed */ }
  output('viewer stopped')
}

function marketplaceEntry() {
  const rows = claudeJson(['plugin', 'marketplace', 'list', '--json'], 'marketplace list')
  return rows.find((row) => row.name === MARKETPLACE) || null
}

function installedPlugin(): any {
  const rows = claudeJson(['plugin', 'list', '--json'], 'plugin list')
  return rows.find((row) => row.id === PLUGIN_ID) || null
}

function addLocalMarketplace() {
  // Claude Code 2.1.x rejects Windows drive-letter paths here but accepts a
  // relative source. Running from the package root keeps global npm paths portable.
  runClaude(['plugin', 'marketplace', 'add', './'], { cwd: PLUGIN_ROOT })
}

function ensureMarketplace() {
  const marketplace = marketplaceEntry()
  if (!marketplace) {
    addLocalMarketplace()
    return
  }
  const registeredPath = marketplace.source === 'directory' && marketplace.path
    ? resolve(marketplace.path)
    : null
  if (registeredPath && registeredPath !== resolve(PLUGIN_ROOT)) {
    output(`marketplace package path changed; re-registering ${PLUGIN_ROOT}`)
    runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE])
    addLocalMarketplace()
    return
  }
  runClaude(['plugin', 'marketplace', 'update', MARKETPLACE])
}

function installPlugin() {
  runClaude(['plugin', 'validate', PLUGIN_ROOT])
  ensureMarketplace()
  const installed = installedPlugin()
  if (installed) runClaude(['plugin', 'update', PLUGIN_ID, '--scope', installed.scope || 'user'])
  else runClaude(['plugin', 'install', PLUGIN_ID, '--scope', 'user'])
  migrateLegacySettings()
  output(`plugin installed: ${PLUGIN_ID}`)
  output('restart Claude Code or run /reload-plugins in an active session')
}

function updatePlugin() {
  runClaude(['plugin', 'validate', PLUGIN_ROOT])
  ensureMarketplace()
  const installed = installedPlugin()
  if (installed) runClaude(['plugin', 'update', PLUGIN_ID, '--scope', installed.scope || 'user'])
  else runClaude(['plugin', 'install', PLUGIN_ID, '--scope', 'user'])
  output(`plugin updated: ${PLUGIN_ID}`)
}

function uninstallPlugin(args) {
  const installed = installedPlugin()
  if (installed) runClaude(['plugin', 'uninstall', PLUGIN_ID, '--scope', installed.scope || 'user'])
  else output('plugin is not installed')
  if (args.includes('--remove-marketplace') && marketplaceEntry()) {
    runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE])
  }
  output(`trajectory data preserved at ${join(CLAUDE_CONFIG, 'trajectories')}`)
}

async function showStatus(args) {
  const port = portOf(args)
  let plugin: any = null
  let marketplace: any = null
  try { marketplace = marketplaceEntry(); plugin = installedPlugin() } catch { /* doctor reports CLI issues */ }
  const state = readViewerState()
  const health = await viewerHealth(port)
  output(`package:     ${PACKAGE.name}@${PACKAGE.version}`)
  output(`marketplace: ${marketplace ? 'installed' : 'not installed'}`)
  output(`plugin:      ${plugin ? `${plugin.enabled ? 'enabled' : 'disabled'} (${plugin.version}, ${plugin.scope})` : 'not installed'}`)
  output(`viewer:      ${health ? `running at http://127.0.0.1:${port}` : 'stopped'}`)
  if (state) output(`viewer pid:  ${state.pid}${pidAlive(state.pid) ? '' : ' (stale)'}`)
  output(`data:        ${process.env.TRAJECTORY_ROOT || join(CLAUDE_CONFIG, 'trajectories')}`)
}

async function doctor(args) {
  output(`Node: ${process.version}`)
  const claudeVersion = runClaude(['--version'], { capture: true })
  output(`Claude Code: ${claudeVersion.stdout.trim()}`)
  runClaude(['plugin', 'validate', PLUGIN_ROOT])
  await showStatus(args)
}

function help() {
  output(`agent-trajectory ${PACKAGE.version}

Usage: trajectory <command> [options]

Commands:
  install                 Validate and install the Claude Code plugin
  update                  Refresh the marketplace and plugin
  uninstall               Uninstall the plugin (keeps trajectory data)
  start [--port N]        Start Viewer in background and open the browser
  serve [--port N]        Run Viewer in the foreground
  stop                    Stop a Viewer started by trajectory
  status [--port N]       Show plugin and Viewer status
  doctor [--port N]       Validate prerequisites and installation
  open [--port N]         Open the Viewer in the default browser

Options:
  --no-open               Do not open the browser after start
  --force                 Stop the recorded pid even when health check fails
  --remove-marketplace    Also remove the marketplace during uninstall
  -h, --help              Show this help
  -v, --version           Show package version`)
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0]
  const rest = args.slice(1)
  if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) return help()
  if (command === '--version' || command === '-v' || command === 'version') return output(PACKAGE.version)
  if (command === 'install') return installPlugin()
  if (command === 'update') return updatePlugin()
  if (command === 'uninstall') return uninstallPlugin(rest)
  if (command === 'start') return startViewer(rest)
  if (command === 'serve') return serveViewer(rest)
  if (command === 'stop') return stopViewer(rest)
  if (command === 'status') return showStatus(rest)
  if (command === 'doctor') return doctor(rest)
  if (command === 'open') return openBrowser(portOf(rest))
  fail(`unknown command: ${command}\nRun "trajectory --help" for usage.`)
}

export function sameExecutablePath(left: string, right: string) {
  const canonical = (path: string) => {
    let value
    try { value = realpathSync.native(path) } catch { value = resolve(path) }
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return canonical(left) === canonical(right)
}

const invokedPath = process.argv[1] || ''
if (invokedPath && sameExecutablePath(invokedPath, fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`trajectory: ${error.message}`)
    process.exitCode = 1
  })
}

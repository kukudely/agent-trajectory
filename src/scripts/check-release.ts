#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const pkg = readJson('package.json')
const manifest = readJson('.claude-plugin/plugin.json')
const marketplace = readJson('.claude-plugin/marketplace.json')
const codexManifest = readJson('plugins/agent-trajectory/.codex-plugin/plugin.json')
const codexMarketplace = readJson('.agents/plugins/marketplace.json')
const entry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name)

const errors: string[] = []
if (pkg.version !== manifest.version) errors.push(`package ${pkg.version} != plugin ${manifest.version}`)
if (pkg.version !== codexManifest.version) errors.push(`package ${pkg.version} != Codex plugin ${codexManifest.version}`)
if (!codexMarketplace.plugins?.some((plugin) => plugin.name === codexManifest.name)) errors.push('Codex marketplace entry is missing')
if (!entry) errors.push(`marketplace does not contain ${manifest.name}`)
else if (entry.version !== pkg.version) errors.push(`package ${pkg.version} != marketplace ${entry.version}`)
if (!existsSync(join(root, 'hooks', 'hooks.json'))) errors.push('hooks/hooks.json is missing')
if (!existsSync(join(root, 'dist', 'hooks', 'session-start.js'))) errors.push('compiled hooks are missing')
if (!existsSync(join(root, 'dist', 'viewer', 'index.html'))) errors.push('compiled viewer assets are missing')
if (!pkg.files?.includes('.claude-plugin')) errors.push('package files does not include .claude-plugin')
if (!pkg.files?.includes('plugins/agent-trajectory')) errors.push('package files does not include Codex plugin')
if (!pkg.bin?.trajectory) errors.push('package bin does not expose trajectory')
if (pkg.bin?.['agent-trajectory'] !== pkg.bin?.trajectory) errors.push('npx package-name alias is missing')
if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org') errors.push('public npm publish registry is not pinned')

if (errors.length) {
  console.error('release validation failed:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.error(`release metadata OK: ${pkg.name}@${pkg.version}`)

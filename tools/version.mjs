#!/usr/bin/env node
/**
 * Single source of truth for the version: `package.json`.
 *
 *   node tools/version.mjs check                  # package.json == manifest.json, CHANGELOG has the section
 *   node tools/version.mjs bump patch|minor|major # updates package.json, manifest.json and CHANGELOG
 *
 * The rule for this repository: every commit that changes shipped code bumps
 * the version and updates CHANGELOG; docs-only commits do not.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = {
  pkg: join(root, 'package.json'),
  manifest: join(root, 'extension', 'manifest.json'),
  changelog: join(root, 'CHANGELOG.md')
}

const readText = (path) => readFile(path, 'utf8')
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

export function bumpVersion(version, kind) {
  const [major, minor, patch] = String(version).split('.').map(Number)
  if (![major, minor, patch].every(Number.isInteger)) throw new Error(`not a semver version: ${version}`)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump kind: ${kind} (use patch, minor or major)`)
}

/** Local date, so a release is stamped with the day the author ships it. */
export function today() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function readState() {
  return {
    pkg: JSON.parse(await readText(files.pkg)),
    manifest: JSON.parse(await readText(files.manifest)),
    changelog: await readText(files.changelog)
  }
}

async function check() {
  const { pkg, manifest, changelog } = await readState()
  const problems = []
  if (pkg.version !== manifest.version) {
    problems.push(`package.json is ${pkg.version}, extension/manifest.json is ${manifest.version}`)
  }
  if (!changelog.includes(`## [${pkg.version}]`)) {
    problems.push(`CHANGELOG.md has no "## [${pkg.version}]" section`)
  }
  if (problems.length > 0) {
    console.error('version check failed:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`version ${pkg.version} is consistent (package.json, manifest.json, CHANGELOG.md)`)
}

/**
 * Inserts a new release section right below [Unreleased], keeping whatever the
 * Unreleased section already says and the whole history below it untouched.
 */
export function insertSection(changelog, version, date) {
  const marker = '## [Unreleased]'
  const at = changelog.indexOf(marker)
  if (at === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  const head = changelog.slice(0, at + marker.length)
  const rest = changelog.slice(at + marker.length)

  const nextAt = rest.indexOf('\n## [')
  const unreleased = (nextAt === -1 ? rest : rest.slice(0, nextAt)).trimEnd()
  const history = nextAt === -1 ? '' : rest.slice(nextAt).replace(/^\n+/, '\n')

  const section = [`## [${version}] — ${date}`, '', '### Added', '', '- ', ''].join('\n')
  return `${head}${unreleased}\n\n${section}${history}`
}

async function bump(kind) {
  const { pkg, manifest, changelog } = await readState()
  const next = bumpVersion(pkg.version, kind)
  const date = today()

  pkg.version = next
  manifest.version = next
  await writeJson(files.pkg, pkg)
  await writeJson(files.manifest, manifest)
  await writeFile(files.changelog, insertSection(changelog, next, date), 'utf8')

  console.log(`bumped ${kind}: ${next}`)
  console.log(`  package.json  → ${next}`)
  console.log(`  manifest.json → ${next}`)
  console.log(`  CHANGELOG.md  → added "## [${next}] — ${date}", fill it in`)
  console.log('')
  console.log('next:')
  console.log('  git add -A')
  console.log(`  git commit -m "release: v${next}"`)
  console.log(`  git tag -a v${next} -m "v${next}" && git push origin main --tags`)
}

// Only act as a CLI when executed directly, so tests can import the helpers.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
const isCli = invokedPath === fileURLToPath(import.meta.url)

if (isCli) {
  const [command, argument] = process.argv.slice(2)
  if (command === 'check') await check()
  else if (command === 'bump') await bump(argument ?? 'patch')
  else {
    console.error('usage: node tools/version.mjs check | bump patch|minor|major')
    process.exit(1)
  }
}

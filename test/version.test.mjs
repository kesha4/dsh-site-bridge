/**
 * The version helper is the only thing that writes the version, so its
 * CHANGELOG surgery is worth a test: a broken insert silently eats history.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bumpVersion, insertSection, today } from '../tools/version.mjs'

const CHANGELOG = `# Changelog

## [Unreleased]

_Nothing yet._

## [0.3.0] — 2026-11-02

### Added

- previous release

## [0.2.0] — 2026-11-02

### Added

- older release
`

test('bumpVersion follows semver', () => {
  assert.equal(bumpVersion('0.3.1', 'patch'), '0.3.2')
  assert.equal(bumpVersion('0.3.1', 'minor'), '0.4.0')
  assert.equal(bumpVersion('0.3.1', 'major'), '1.0.0')
  assert.throws(() => bumpVersion('0.3.1', 'nope'), /unknown bump kind/)
})

test('today is a local ISO date', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/)
})

test('insertSection keeps [Unreleased] body and the whole history', () => {
  const updated = insertSection(CHANGELOG, '0.4.0', '2026-12-01')
  assert.match(updated, /## \[Unreleased\]\n\n_Nothing yet\._\n\n## \[0\.4\.0\] — 2026-12-01/)
  assert.match(updated, /- previous release/)
  assert.match(updated, /- older release/)
  // exactly one new section, nothing duplicated
  assert.equal((updated.match(/## \[0\.4\.0\]/g) ?? []).length, 1)
  assert.ok(updated.indexOf('## [0.4.0]') < updated.indexOf('## [0.3.0]'))
})

test('insertSection refuses a changelog without an Unreleased section', () => {
  assert.throws(() => insertSection('# Empty\n', '0.4.0', '2026-12-01'), /Unreleased/)
})

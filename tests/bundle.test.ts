import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = fileURLToPath(new URL('../dist/setui.js', import.meta.url))

/**
 * Builds the distributable and runs it the way a user would: one file, plain
 * `node`, no node_modules beside it. This is the only test that proves the bundle
 * actually loads — several dependencies are CommonJS and would fail at import time
 * without the require shim.
 */
describe('the single-file bundle', () => {
  beforeAll(async () => {
    await run('node', ['build.mjs'], { cwd: root })
  }, 120_000)

  it('starts with a shebang, so it is directly executable', () => {
    expect(statSync(bundle).size).toBeGreaterThan(1000)
    expect(readFileSync(bundle, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('is self-contained: it runs when copied away from this repo', async () => {
    // Module resolution follows the file, not the working directory, so copying it
    // somewhere with no node_modules above it is what actually proves the point.
    // ESM resolves every static import before running a line, so a single
    // successful invocation exercises the whole import graph.
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'setui-dist-')), 'setui.js')
    copyFileSync(bundle, elsewhere)
    const { stdout } = await run('node', [elsewhere, '--version'])
    expect(stdout.trim()).toBeTruthy()
  })

  it('runs with a bare node invocation', async () => {
    const { stdout } = await run('node', [bundle, '--version'])
    expect(stdout.trim()).toBe(JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version)
  })

  it('prints usage', async () => {
    const { stdout } = await run('node', [bundle, '--help'])
    expect(stdout).toContain('setui')
    expect(stdout).toContain('--version')
    expect(stdout).toContain('.setui.json')
  })

})

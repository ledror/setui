import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/tui/config.js'

const temp = () => join(mkdtempSync(join(tmpdir(), 'setui-cfg-')), '.setui.json')

describe('loadConfig', () => {
  it('creates the file with empty values on first run', async () => {
    const path = temp()
    const config = await loadConfig(path)
    expect(config.msbuild).toBe('')
    expect(config.editor).toBeTruthy()
    expect(JSON.parse(readFileSync(path, 'utf8')).msbuild).toBe('')
  })

  it('reads an existing config', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuild: 'C:\\msbuild.exe', editor: 'code -w' }))
    expect(await loadConfig(path)).toEqual({ msbuild: 'C:\\msbuild.exe', editor: 'code -w' })
  })

  it('fills in a default editor when the key is missing', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuild: 'x' }))
    expect((await loadConfig(path)).editor).toBeTruthy()
  })

  it('reports invalid JSON instead of overwriting it', async () => {
    const path = temp()
    writeFileSync(path, '{ not json')
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOG_LINES, loadConfig } from '../src/tui/config.js'

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
    writeFileSync(path, JSON.stringify({ msbuild: 'C:\\msbuild.exe', editor: 'code -w', logLines: 20 }))
    expect(await loadConfig(path)).toEqual({ msbuild: 'C:\\msbuild.exe', editor: 'code -w', logLines: 20 })
  })

  it('defaults the build pane to 15 lines', async () => {
    expect((await loadConfig(temp())).logLines).toBe(DEFAULT_LOG_LINES)
    expect(DEFAULT_LOG_LINES).toBe(15)
  })

  it('clamps a silly logLines rather than rejecting the config', async () => {
    const tiny = temp()
    writeFileSync(tiny, JSON.stringify({ logLines: 0 }))
    expect((await loadConfig(tiny)).logLines).toBe(3)

    const huge = temp()
    writeFileSync(huge, JSON.stringify({ logLines: 5000 }))
    expect((await loadConfig(huge)).logLines).toBe(60)

    const nonsense = temp()
    writeFileSync(nonsense, JSON.stringify({ logLines: 'lots' }))
    expect((await loadConfig(nonsense)).logLines).toBe(DEFAULT_LOG_LINES)
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

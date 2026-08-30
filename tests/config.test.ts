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
    expect(config.msbuild).toEqual({ build: '', compileCommands: '' })
    expect(config.editor).toBeTruthy()
    expect(JSON.parse(readFileSync(path, 'utf8')).msbuild).toEqual({ build: '', compileCommands: '' })
  })

  it('reads an existing config', async () => {
    const path = temp()
    writeFileSync(
      path,
      JSON.stringify({
        msbuild: { build: 'C:\\msbuild.exe', compileCommands: 'C:\\new\\msbuild.exe' },
        editor: 'code -w',
        logLines: 20,
      }),
    )
    expect(await loadConfig(path)).toEqual({
      msbuild: { build: 'C:\\msbuild.exe', compileCommands: 'C:\\new\\msbuild.exe' },
      editor: 'code -w',
      logLines: 20,
      msbuildArgs: [],
    })
  })

  it('still reads the string msbuild every older config has', async () => {
    // Configs written before compile_commands.json existed say
    // "msbuild": "C:\\...\\MSBuild.exe", and that still means the build MSBuild.
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuild: 'C:\\msbuild.exe' }))
    expect((await loadConfig(path)).msbuild).toEqual({
      build: 'C:\\msbuild.exe',
      compileCommands: '',
    })
  })

  it('does not rewrite a config it read in the older shape', async () => {
    // The file is the user's. loadConfig refuses to migrate it behind their back
    // for the same reason it refuses to replace invalid JSON.
    const path = temp()
    const original = JSON.stringify({ msbuild: 'C:\\msbuild.exe' })
    writeFileSync(path, original)
    await loadConfig(path)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('degrades a nonsensical msbuild to empty rather than failing to start', async () => {
    for (const value of [7, ['a'], null, { build: 3 }]) {
      const path = temp()
      writeFileSync(path, JSON.stringify({ msbuild: value }))
      expect((await loadConfig(path)).msbuild.build).toBe('')
    }
  })

  it('takes only the half of the object that is present', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuild: { compileCommands: 'C:\\new.exe' } }))
    expect((await loadConfig(path)).msbuild).toEqual({ build: '', compileCommands: 'C:\\new.exe' })
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
    writeFileSync(path, JSON.stringify({ msbuild: { build: 'x' } }))
    expect((await loadConfig(path)).editor).toBeTruthy()
  })

  it('has no extra msbuild arguments by default', async () => {
    expect((await loadConfig(temp())).msbuildArgs).toEqual([])
  })

  it('splits a string of msbuild arguments on whitespace', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuildArgs: '/v:m  /nodeReuse:false' }))
    expect((await loadConfig(path)).msbuildArgs).toEqual(['/v:m', '/nodeReuse:false'])
  })

  it('takes an array verbatim, spaces and all', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuildArgs: ['/p:Banner=Hello World', '/v:q'] }))
    expect((await loadConfig(path)).msbuildArgs).toEqual(['/p:Banner=Hello World', '/v:q'])
  })

  it('ignores junk in the array rather than failing to start', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuildArgs: ['/v:m', '', 7, null] }))
    expect((await loadConfig(path)).msbuildArgs).toEqual(['/v:m'])
  })

  it('ignores a msbuildArgs that is neither a string nor an array', async () => {
    const path = temp()
    writeFileSync(path, JSON.stringify({ msbuildArgs: { v: 'm' } }))
    expect((await loadConfig(path)).msbuildArgs).toEqual([])
  })

  it('reports invalid JSON instead of overwriting it', async () => {
    const path = temp()
    writeFileSync(path, '{ not json')
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})

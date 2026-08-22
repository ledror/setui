import { describe, expect, it } from 'vitest'
import { buildArgs } from '../src/core/build.js'

const base = {
  solutionPath: 'C:\\src\\My Solution\\demo.sln',
  virtualPath: 'Drivers\\Sample',
  target: 'Rebuild' as const,
  configuration: 'Debug',
  platform: 'x64',
}

describe('buildArgs', () => {
  it('produces the msbuild argument vector', () => {
    expect(buildArgs(base)).toEqual([
      'C:\\src\\My Solution\\demo.sln',
      '/t:Drivers\\Sample:Rebuild',
      '/p:Configuration=Debug',
      '/p:Platform=x64',
      '/m',
      '/nologo',
    ])
  })

  it('keeps arguments unquoted and unjoined so spawn can pass them verbatim', () => {
    expect(buildArgs(base)[0]).toBe(base.solutionPath)
  })

  it('supports every target', () => {
    for (const target of ['Build', 'Rebuild', 'Clean'] as const) {
      expect(buildArgs({ ...base, target })).toContain(`/t:Drivers\\Sample:${target}`)
    }
  })

  it('rejects a forward-slashed virtual path', () => {
    expect(() => buildArgs({ ...base, virtualPath: 'Drivers/Sample' })).toThrow(/backslash/i)
  })

  it('rejects an empty virtual path', () => {
    expect(() => buildArgs({ ...base, virtualPath: '' })).toThrow(/virtual path/i)
  })

  it('passes a platform containing a bar through untouched', () => {
    expect(buildArgs({ ...base, platform: 'ARM64' })).toContain('/p:Platform=ARM64')
  })
})

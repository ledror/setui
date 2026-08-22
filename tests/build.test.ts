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

  it('names the target explicitly for Rebuild and Clean', () => {
    for (const target of ['Rebuild', 'Clean'] as const) {
      expect(buildArgs({ ...base, target })).toContain(`/t:Drivers\\Sample:${target}`)
    }
  })

  it('passes no target suffix for a plain Build', () => {
    // msbuild rejects the explicit `Project:Build` form; Build is the default.
    const args = buildArgs({ ...base, target: 'Build' })
    expect(args).toContain('/t:Drivers\\Sample')
    expect(args.some((a) => a.endsWith(':Build'))).toBe(false)
  })

  it('still builds the right project when the name contains a dot', () => {
    const args = buildArgs({ ...base, virtualPath: 'Folder\\My_Lib', target: 'Build' })
    expect(args).toContain('/t:Folder\\My_Lib')
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

import { describe, expect, it } from 'vitest'
import { buildArgs, commandLine } from '../src/core/build.js'

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

  it('appends nothing when there are no extra arguments', () => {
    expect(buildArgs(base).at(-1)).toBe('/nologo')
  })

  it('appends extra arguments last, so they win over our defaults', () => {
    const args = buildArgs({ ...base, extraArgs: ['/v:m', '/m:4'] })
    expect(args.slice(-2)).toEqual(['/v:m', '/m:4'])
    expect(args.indexOf('/m')).toBeLessThan(args.indexOf('/m:4'))
  })

  it('passes extra arguments through verbatim, spaces and all', () => {
    const args = buildArgs({ ...base, extraArgs: ['/p:Banner=Hello World'] })
    expect(args).toContain('/p:Banner=Hello World')
  })

  it('passes a platform containing a bar through untouched', () => {
    expect(buildArgs({ ...base, platform: 'ARM64' })).toContain('/p:Platform=ARM64')
  })
})

describe('commandLine', () => {
  it('renders the invocation for the log', () => {
    expect(commandLine('msbuild.exe', ['/t:A', '/m'])).toBe('msbuild.exe /t:A /m')
  })

  it('quotes anything containing a space, so it can be pasted into a terminal', () => {
    const line = commandLine('C:\\Program Files\\msbuild.exe', ['C:\\my sln\\a.sln', '/m'])
    expect(line).toBe('"C:\\Program Files\\msbuild.exe" "C:\\my sln\\a.sln" /m')
  })

  it('escapes embedded quotes', () => {
    expect(commandLine('m.exe', ['/p:X=a "b" c'])).toBe('m.exe "/p:X=a \\"b\\" c"')
  })

  it('shows the extra arguments the user configured', () => {
    const args = buildArgs({ ...base, extraArgs: ['/v:m'] })
    expect(commandLine('m.exe', args)).toContain('/v:m')
  })
})

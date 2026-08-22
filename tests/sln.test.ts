import { describe, expect, it } from 'vitest'
import { parseSln, SlnParseError } from '../src/core/sln.js'

const CRLF = '\r\n'
const sln = (...lines: string[]) => '﻿' + lines.join(CRLF) + CRLF

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}'
const FOLDER = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}'

const basic = sln(
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio 15',
  `Project("${CPP}") = "Alpha", "alpha\\Alpha.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
  'EndProject',
  `Project("${CPP}") = "Beta.Core", "beta\\Beta.vcxproj", "{BBBBBBBB-0000-0000-0000-000000000002}"`,
  'EndProject',
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\t\tRelease|x64 = Release|x64',
  '\t\tDebug|x64 = Debug|x64',
  '\t\tDebug|Win32 = Debug|Win32',
  '\tEndGlobalSection',
  '\tGlobalSection(SolutionProperties) = preSolution',
  '\t\tHideSolutionNode = FALSE',
  '\tEndGlobalSection',
  'EndGlobal',
)

describe('parseSln', () => {
  it('round-trips the source byte for byte', () => {
    expect(parseSln(basic).source).toBe(basic)
  })

  it('covers every byte with a line', () => {
    const doc = parseSln(basic)
    expect(doc.bom + doc.lines.map((l) => doc.source.slice(l.start, l.end)).join('')).toBe(basic)
  })

  it('reads projects', () => {
    const doc = parseSln(basic)
    expect(doc.projects.map((p) => p.name)).toEqual(['Alpha', 'Beta.Core'])
    expect(doc.projects[0]!.path).toBe('alpha\\Alpha.vcxproj')
    expect(doc.projects[0]!.guid).toBe('{AAAAAAAA-0000-0000-0000-000000000001}')
    expect(doc.projects[0]!.typeGuid).toBe(CPP)
    expect(doc.projects[0]!.isFolder).toBe(false)
  })

  it('sorts and de-duplicates configurations and platforms', () => {
    const doc = parseSln(basic)
    expect(doc.configurations).toEqual(['Debug', 'Release'])
    expect(doc.platforms).toEqual(['Win32', 'x64'])
  })

  it('defaults to a debug configuration and an x64 platform', () => {
    expect(parseSln(basic).defaultConfigPlatform()).toEqual({ configuration: 'Debug', platform: 'x64' })
  })

  it('falls back to the first sorted entry when nothing matches', () => {
    const s = sln(
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      'Global',
      '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
      '\t\tShip|ARM64 = Ship|ARM64',
      '\t\tProfile|ARM = Profile|ARM',
      '\tEndGlobalSection',
      'EndGlobal',
    )
    expect(parseSln(s).defaultConfigPlatform()).toEqual({ configuration: 'Profile', platform: 'ARM' })
  })

  it('returns the project name as the virtual path when there are no folders', () => {
    const doc = parseSln(basic)
    expect(doc.virtualPath(doc.projects[0]!.guid)).toBe('Alpha')
  })

  it('escapes dots in project and folder names', () => {
    const doc = parseSln(basic)
    expect(doc.virtualPath(doc.projects[1]!.guid)).toBe('Beta_Core')
  })

  it('builds nested virtual paths with backslashes', () => {
    const s = sln(
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("${FOLDER}") = "Outer", "Outer", "{F0000000-0000-0000-0000-000000000001}"`,
      'EndProject',
      `Project("${FOLDER}") = "In.ner", "In.ner", "{F0000000-0000-0000-0000-000000000002}"`,
      'EndProject',
      `Project("${CPP}") = "Deep", "d\\Deep.vcxproj", "{DDDDDDDD-0000-0000-0000-000000000003}"`,
      'EndProject',
      'Global',
      '\tGlobalSection(NestedProjects) = preSolution',
      '\t\t{F0000000-0000-0000-0000-000000000002} = {F0000000-0000-0000-0000-000000000001}',
      '\t\t{DDDDDDDD-0000-0000-0000-000000000003} = {F0000000-0000-0000-0000-000000000002}',
      '\tEndGlobalSection',
      'EndGlobal',
    )
    const doc = parseSln(s)
    expect(doc.virtualPath('{DDDDDDDD-0000-0000-0000-000000000003}')).toBe('Outer\\In_ner\\Deep')
    expect(doc.projects.filter((p) => p.isFolder).map((p) => p.name)).toEqual(['Outer', 'In.ner'])
  })

  it('skips ProjectSection blocks', () => {
    const s = sln(
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("${CPP}") = "A", "a\\A.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
      '\tProjectSection(ProjectDependencies) = postProject',
      '\t\t{BBBBBBBB-0000-0000-0000-000000000002} = {BBBBBBBB-0000-0000-0000-000000000002}',
      '\tEndProjectSection',
      'EndProject',
      'Global',
      'EndGlobal',
    )
    const doc = parseSln(s)
    expect(doc.projects).toHaveLength(1)
    expect(doc.source).toBe(s)
  })

  it('handles LF-only solutions with no BOM', () => {
    const s = 'Microsoft Visual Studio Solution File, Format Version 12.00\nGlobal\nEndGlobal\n'
    const doc = parseSln(s)
    expect(doc.bom).toBe('')
    expect(doc.source).toBe(s)
  })

  it('accepts the blank line Visual Studio writes before the header', () => {
    const s = '\uFEFF' + CRLF + 'Microsoft Visual Studio Solution File, Format Version 12.00' + CRLF + 'Global' + CRLF + 'EndGlobal' + CRLF
    expect(parseSln(s).source).toBe(s)
  })

  it('throws when the header is missing', () => {
    expect(() => parseSln('not a solution\r\n')).toThrow(SlnParseError)
  })

  it('throws on an unterminated project block', () => {
    const s = sln(
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("${CPP}") = "A", "a\\A.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
    )
    expect(() => parseSln(s)).toThrow(/EndProject/i)
  })

  it('throws when a nested parent is missing', () => {
    const s = sln(
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("${CPP}") = "A", "a\\A.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
      'EndProject',
      'Global',
      '\tGlobalSection(NestedProjects) = preSolution',
      '\t\t{AAAAAAAA-0000-0000-0000-000000000001} = {99999999-0000-0000-0000-000000000000}',
      '\tEndGlobalSection',
      'EndGlobal',
    )
    expect(() => parseSln(s).virtualPath('{AAAAAAAA-0000-0000-0000-000000000001}')).toThrow(/unknown/i)
  })
})

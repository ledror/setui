import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NS = 'http://schemas.microsoft.com/developer/msbuild/2003'
const crlf = (lines: string[]) => '﻿' + lines.join('\r\n') + '\r\n'

export const VCXPROJ = crlf([
  '<?xml version="1.0" encoding="utf-8"?>',
  `<Project DefaultTargets="Build" ToolsVersion="12.0" xmlns="${NS}">`,
  '  <ItemGroup Label="ProjectConfigurations">',
  '    <ProjectConfiguration Include="Debug|x64">',
  '      <Configuration>Debug</Configuration>',
  '      <Platform>x64</Platform>',
  '    </ProjectConfiguration>',
  '  </ItemGroup>',
  '  <PropertyGroup Label="Globals">',
  '    <ProjectGuid>{11111111-1111-1111-1111-111111111111}</ProjectGuid>',
  '  </PropertyGroup>',
  '  <ItemGroup>',
  '    <ClCompile Include="main.c" />',
  '    <ClCompile Include="util.c" />',
  '  </ItemGroup>',
  '  <ItemGroup>',
  '    <ClInclude Include="main.h" />',
  '  </ItemGroup>',
  '</Project>',
])

export const FILTERS = crlf([
  '<?xml version="1.0" encoding="utf-8"?>',
  `<Project ToolsVersion="4.0" xmlns="${NS}">`,
  '  <ItemGroup>',
  '    <Filter Include="Source Files">',
  '      <UniqueIdentifier>{4FC737F1-C7A5-4376-A066-2A32D752A2FF}</UniqueIdentifier>',
  '      <Extensions>cpp;c;cc;cxx</Extensions>',
  '    </Filter>',
  '    <Filter Include="Source Files\\Nested">',
  '      <UniqueIdentifier>{AAAAAAAA-0000-0000-0000-00000000000A}</UniqueIdentifier>',
  '    </Filter>',
  '    <Filter Include="Source Files Old">',
  '      <UniqueIdentifier>{BBBBBBBB-0000-0000-0000-00000000000B}</UniqueIdentifier>',
  '    </Filter>',
  '  </ItemGroup>',
  '  <ItemGroup>',
  '    <ClCompile Include="main.c">',
  '      <Filter>Source Files</Filter>',
  '    </ClCompile>',
  '    <ClCompile Include="nested.c">',
  '      <Filter>Source Files\\Nested</Filter>',
  '    </ClCompile>',
  '    <ClCompile Include="old.c">',
  '      <Filter>Source Files Old</Filter>',
  '    </ClCompile>',
  '  </ItemGroup>',
  '</Project>',
])

/** A vcxproj that also declares the two extra files the filters file references. */
export const VCXPROJ_FULL = VCXPROJ.replace(
  '    <ClCompile Include="util.c" />',
  '    <ClCompile Include="util.c" />\r\n    <ClCompile Include="nested.c" />\r\n    <ClCompile Include="old.c" />',
)

export interface Fixture {
  dir: string
  vcxproj: string
  filters: string
}

/** Writes a throwaway project to the OS temp dir. Never touches sample-projects/. */
export function writeFixture(opts: { vcxproj?: string; filters?: string | null } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'setui-'))
  const vcxproj = join(dir, 'Demo.vcxproj')
  writeFileSync(vcxproj, opts.vcxproj ?? VCXPROJ_FULL, 'utf8')
  const filters = `${vcxproj}.filters`
  if (opts.filters !== null) writeFileSync(filters, opts.filters ?? FILTERS, 'utf8')
  return { dir, vcxproj, filters }
}

/** A counter-based GUID source so tests are deterministic. */
export function fakeGuids(): () => string {
  let n = 0
  return () => `{00000000-0000-0000-0000-${String(++n).padStart(12, '0')}}`
}

import { lineColumn } from './text.js'

/**
 * A line-oriented CST for `.sln` files.
 *
 * Solutions are read-only in setui (see ARCHITECTURE.md), so this parser has no
 * splice support. It still tiles the source completely with `lines`, which is what
 * proves it isn't silently dropping content it failed to understand.
 */

export interface SlnLine {
  start: number
  /** Offset just past the line's terminator, so lines tile the source. */
  end: number
}

export interface SlnProject {
  typeGuid: string
  name: string
  /** As written: relative, backslash-separated. A folder repeats its own name here. */
  path: string
  guid: string
  isFolder: boolean
}

export interface SlnSection {
  name: string
  /** `key = value` pairs, in file order, trimmed. */
  entries: [string, string][]
}

export class SlnParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'SlnParseError'
  }
}

const BOM = '﻿'
const FOLDER_TYPE_GUID = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}'
const HEADER = 'Microsoft Visual Studio Solution File'

const PROJECT_RE = /^Project\("(\{[^"]*\})"\)\s*=\s*"([^"]*)",\s*"([^"]*)",\s*"(\{[^"]*\})"\s*$/
const SECTION_RE = /^GlobalSection\(([^)]*)\)\s*=/

export class SlnDocument {
  constructor(
    readonly source: string,
    readonly bom: string,
    readonly lines: SlnLine[],
    readonly projects: SlnProject[],
    readonly sections: SlnSection[],
    /** child guid -> parent guid */
    readonly nested: Map<string, string>,
  ) {}

  section(name: string): SlnSection | undefined {
    return this.sections.find((s) => s.name === name)
  }

  /** Distinct `Configuration` parts of the solution's Configuration|Platform pairs. */
  get configurations(): string[] {
    return distinctSorted(this.configPlatformPairs().map(([c]) => c))
  }

  get platforms(): string[] {
    return distinctSorted(this.configPlatformPairs().map(([, p]) => p))
  }

  private configPlatformPairs(): [string, string][] {
    const section =
      this.section('SolutionConfigurationPlatforms') ?? this.section('ProjectConfigurationPlatforms')
    if (!section) return []
    const pairs: [string, string][] = []
    for (const [key] of section.entries) {
      // 'Debug|x64' or '{guid}.Debug|x64.ActiveCfg'
      const bar = key.indexOf('|')
      if (bar < 0) continue
      const dot = key.lastIndexOf('.', bar)
      const configuration = key.slice(dot + 1, bar)
      const rest = key.slice(bar + 1)
      const platform = rest.split('.')[0]!
      if (configuration && platform) pairs.push([configuration, platform])
    }
    return pairs
  }

  /**
   * The default the TUI opens with: the first configuration containing 'debug' and
   * the first platform containing 'x64', case-insensitively, over the sorted lists.
   * Sorting first keeps the choice stable across runs.
   */
  defaultConfigPlatform(): { configuration: string; platform: string } {
    const pick = (values: string[], want: string) =>
      values.find((v) => v.toLowerCase().includes(want)) ?? values[0] ?? ''
    return {
      configuration: pick(this.configurations, 'debug'),
      platform: pick(this.platforms, 'x64'),
    }
  }

  /**
   * The project's path *inside* the solution, which is what msbuild's `/t:` wants:
   * backslash-separated solution folders, no extension, and `.` escaped to `_`
   * because msbuild reads a dot in a target name as a property separator.
   */
  virtualPath(guid: string): string {
    const byGuid = new Map(this.projects.map((p) => [p.guid, p]))
    const segments: string[] = []
    let current: string | undefined = guid
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current)) throw new Error(`cyclic NestedProjects entry at ${current}`)
      seen.add(current)
      const project = byGuid.get(current)
      if (!project) throw new Error(`unknown project guid ${current}`)
      segments.unshift(project.name.replaceAll('.', '_'))
      current = this.nested.get(current)
    }
    return segments.join('\\')
  }
}

export function parseSln(source: string): SlnDocument {
  const bom = source.startsWith(BOM) ? BOM : ''
  const lines = splitLines(source, bom.length)

  const fail = (message: string, offset: number): never => {
    const { line, column } = lineColumn(source, offset)
    throw new SlnParseError(message, offset, line, column)
  }

  const text = (i: number) => {
    const l = lines[i]!
    return source.slice(l.start, l.end).replace(/\r?\n$/, '')
  }

  // Visual Studio writes a blank line before the header in most solutions it
  // generates, so the header is 'the first non-empty line', not 'line 1'.
  const headerLine = lines.findIndex((_, i) => text(i).trim() !== '')
  if (headerLine < 0 || !text(headerLine).startsWith(HEADER)) {
    fail(`expected a '${HEADER}' header`, lines[Math.max(headerLine, 0)]?.start ?? bom.length)
  }

  const projects: SlnProject[] = []
  const sections: SlnSection[] = []
  const nested = new Map<string, string>()

  for (let i = 0; i < lines.length; i++) {
    const trimmed = text(i).trim()

    if (trimmed.startsWith('Project(')) {
      const m = PROJECT_RE.exec(trimmed)
      if (!m) fail('malformed Project entry', lines[i]!.start)
      const [, typeGuid, name, path, guid] = m as unknown as [string, string, string, string, string]
      projects.push({ typeGuid, name, path, guid, isFolder: typeGuid.toUpperCase() === FOLDER_TYPE_GUID })
      const start = i
      while (i < lines.length && text(i).trim() !== 'EndProject') i++
      if (i >= lines.length) fail('missing EndProject', lines[start]!.start)
      continue
    }

    const sectionMatch = SECTION_RE.exec(trimmed)
    if (sectionMatch) {
      const name = sectionMatch[1]!
      const entries: [string, string][] = []
      const start = i
      i++
      for (; i < lines.length && text(i).trim() !== 'EndGlobalSection'; i++) {
        const entry = text(i).trim()
        if (!entry) continue
        const eq = entry.indexOf('=')
        if (eq < 0) continue
        entries.push([entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()])
      }
      if (i >= lines.length) fail(`missing EndGlobalSection for ${name}`, lines[start]!.start)
      sections.push({ name, entries })
      if (name === 'NestedProjects') for (const [child, parent] of entries) nested.set(child, parent)
    }
  }

  return new SlnDocument(source, bom, lines, projects, sections, nested)
}

function splitLines(source: string, from: number): SlnLine[] {
  const lines: SlnLine[] = []
  let start = from
  while (start < source.length) {
    const nl = source.indexOf('\n', start)
    const end = nl < 0 ? source.length : nl + 1
    lines.push({ start, end })
    start = end
  }
  return lines
}

const distinctSorted = (values: string[]) => [...new Set(values)].sort()

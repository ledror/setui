import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { itemTypeFor, NON_FILE_ITEMS } from './itemTypes.js'
import { applySplices, detectEol, lineIndent, type Splice } from './text.js'
import { attr, childElements, parseXml, type XmlDocument, type XmlElement } from './xml.js'

/**
 * The Project facade: one object over the two files that describe a C++ project,
 * `.vcxproj` and its `.vcxproj.filters`. Callers speak files and filters; they never
 * see that there are two documents, or that edits are byte splices.
 *
 * This module does no filesystem side effects beyond reading and writing those two
 * files. Creating, deleting and renaming files on disk is the TUI's job.
 */

export interface ProjectFile {
  /** Backslash-separated, relative to the project directory, exactly as written. */
  path: string
  /** The MSBuild item element name, e.g. ClCompile. Preserved as found. */
  itemType: string
  /** Filter path, or null for the no-filter bucket. */
  filter: string | null
}

export interface ProjectFilter {
  path: string
  guid: string
}

export interface ProjectReference {
  include: string
  guid: string | null
}

export class StaleFileError extends Error {
  constructor(readonly path: string) {
    super(`${basename(path)} changed on disk since it was opened`)
    this.name = 'StaleFileError'
  }
}

export interface OpenOptions {
  /** Injected so tests are deterministic. Defaults to a Visual Studio-style GUID. */
  newGuid?: () => string
}

const defaultGuid = () => `{${randomUUID().toUpperCase()}}`

export async function openProject(vcxprojPath: string, options: OpenOptions = {}): Promise<Project> {
  const path = resolve(vcxprojPath)
  const vcxproj = await Doc.open(path)
  const filtersPath = `${path}.filters`
  const filters = await Doc.openIfExists(filtersPath)
  return new Project(path, vcxproj, filters, options.newGuid ?? defaultGuid)
}

/** One parsed file, its text, and the stat it had when we read it. */
class Doc {
  dirty = false

  private constructor(
    readonly path: string,
    public text: string,
    public xml: XmlDocument,
    private mtimeMs: number,
    private size: number,
  ) {}

  static async open(path: string): Promise<Doc> {
    const text = await readFile(path, 'utf8')
    const s = await stat(path)
    return new Doc(path, text, parseXml(text), s.mtimeMs, s.size)
  }

  static async openIfExists(path: string): Promise<Doc | null> {
    try {
      return await Doc.open(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  /**
   * Applies splices against the current text and reparses.
   *
   * ponytail: reparses the whole file per mutation instead of tracking offsets
   * across a batch. Project files are tens of kilobytes and edits are keystrokes;
   * batch the splices if a mutation ever shows up in a profile.
   */
  edit(splices: Splice[]): void {
    if (splices.length === 0) return
    this.text = applySplices(this.text, splices)
    this.xml = parseXml(this.text)
    this.dirty = true
  }

  get root(): XmlElement {
    const root = this.xml.children.find(
      (c): c is XmlElement => c.kind === 'element' && c.name === 'Project',
    )
    if (!root) throw new Error(`${basename(this.path)} has no <Project> root element`)
    return root
  }

  get eol(): '\r\n' | '\n' {
    return detectEol(this.text)
  }

  /** One level of indentation, taken from the file itself. */
  get indentUnit(): string {
    for (const group of childElements(this.root)) {
      const child = childElements(group)[0]
      if (!child) continue
      const outer = lineIndent(this.text, group.start)
      const inner = lineIndent(this.text, child.start)
      if (inner.startsWith(outer) && inner.length > outer.length) return inner.slice(outer.length)
    }
    return '  '
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const s = await stat(this.path)
    if (s.mtimeMs !== this.mtimeMs || s.size !== this.size) throw new StaleFileError(this.path)
    // Temp file + rename, so a crash mid-write cannot truncate a project file.
    const temp = `${this.path}.setui-tmp`
    await writeFile(temp, this.text, 'utf8')
    await rename(temp, this.path)
    const after = await stat(this.path)
    this.mtimeMs = after.mtimeMs
    this.size = after.size
    this.dirty = false
  }
}

/** An item element together with the ItemGroup that holds it. */
interface Item {
  el: XmlElement
  group: XmlElement
  include: string
}

export class Project {
  constructor(
    readonly path: string,
    private vcxproj: Doc,
    private filtersDoc: Doc | null,
    private newGuid: () => string,
  ) {}

  get name(): string {
    return basename(this.path, '.vcxproj')
  }

  get dir(): string {
    return dirname(this.path)
  }

  get guid(): string {
    for (const group of childElements(this.vcxproj.root, 'PropertyGroup')) {
      const el = childElements(group, 'ProjectGuid')[0]
      if (el) return this.vcxproj.text.slice(el.openEnd, el.closeStart).trim()
    }
    return ''
  }

  get hasFilters(): boolean {
    return this.filtersDoc !== null
  }

  get vcxprojText(): string {
    return this.vcxproj.text
  }

  get filtersText(): string | null {
    return this.filtersDoc?.text ?? null
  }

  get dirty(): boolean {
    return this.vcxproj.dirty || (this.filtersDoc?.dirty ?? false)
  }

  get files(): ProjectFile[] {
    const assigned = this.filterAssignments()
    return this.items(this.vcxproj).map(({ el, include }) => ({
      path: include,
      itemType: el.name,
      filter: assigned.get(key(include)) ?? null,
    }))
  }

  get filters(): ProjectFilter[] {
    if (!this.filtersDoc) return []
    const doc = this.filtersDoc
    return this.items(doc, 'Filter').map(({ el, include }) => ({
      path: include,
      guid: this.childText(doc, el, 'UniqueIdentifier') ?? '',
    }))
  }

  get references(): ProjectReference[] {
    const doc = this.vcxproj
    return this.items(doc, 'ProjectReference').map(({ el, include }) => ({
      include,
      guid: this.childText(doc, el, 'Project'),
    }))
  }

  // ---------------------------------------------------------------- files

  addFile(path: string, filter?: string): void {
    const p = toBackslash(path)
    if (this.findItem(this.vcxproj, p)) throw new Error(`${p} is already in the project`)
    const itemType = itemTypeFor(p)
    this.insert(this.vcxproj, itemType, (indent) => `<${itemType} Include="${escapeAttr(p)}" />`)
    if (filter !== undefined) {
      this.requireFilters()
      this.requireFilterExists(filter)
      this.insertFilterEntry(p, itemType, filter)
    }
  }

  removeFile(path: string): void {
    const p = toBackslash(path)
    const item = this.findItem(this.vcxproj, p)
    if (item) this.remove(this.vcxproj, item)
    if (this.filtersDoc) {
      const entry = this.findItem(this.filtersDoc, p)
      if (entry) this.remove(this.filtersDoc, entry)
    }
  }

  renameFile(oldPath: string, newPath: string): void {
    const from = toBackslash(oldPath)
    const to = toBackslash(newPath)
    const item = this.findItem(this.vcxproj, from)
    if (!item) throw new Error(`${from} is not in the project`)
    if (this.findItem(this.vcxproj, to)) throw new Error(`${to} is already in the project`)

    // A changed extension can change the item type; leaving a .h as ClCompile would
    // quietly break the build. The item stays in its current ItemGroup.
    const newType = itemTypeFor(to) === itemTypeFor(from) ? item.el.name : itemTypeFor(to)
    this.vcxproj.edit(this.renameItem(item.el, to, newType))
    if (this.filtersDoc) {
      const entry = this.findItem(this.filtersDoc, from)
      if (entry) this.filtersDoc.edit(this.renameItem(entry.el, to, newType))
    }
  }

  private renameItem(el: XmlElement, to: string, newType: string): Splice[] {
    const splices: Splice[] = []
    const include = attr(el, 'Include')!
    splices.push({ start: include.valueStart, end: include.valueEnd, text: escapeAttr(to) })
    if (newType !== el.name) {
      splices.push({ start: el.start + 1, end: el.start + 1 + el.name.length, text: newType })
      if (!el.selfClosing) {
        splices.push({
          start: el.closeStart + 2,
          end: el.closeStart + 2 + el.name.length,
          text: newType,
        })
      }
    }
    return splices
  }

  // -------------------------------------------------------------- filters

  moveToFilter(path: string, filter: string | null): void {
    this.requireFilters()
    const doc = this.filtersDoc!
    const p = toBackslash(path)
    if (filter !== null) this.requireFilterExists(filter)

    const entry = this.findItem(doc, p)
    if (filter === null) {
      // An item with no filter simply does not appear in the filters file, which is
      // what Visual Studio writes too.
      if (entry) this.remove(doc, entry)
      return
    }
    if (!entry) {
      const item = this.findItem(this.vcxproj, p)
      if (!item) throw new Error(`${p} is not in the project`)
      this.insertFilterEntry(p, item.el.name, filter)
      return
    }
    const child = childElements(entry.el, 'Filter')[0]
    if (child) {
      doc.edit([{ start: child.openEnd, end: child.closeStart, text: escapeText(filter) }])
    } else {
      const indent = lineIndent(doc.text, entry.el.start)
      doc.edit([
        {
          start: entry.el.openEnd,
          end: entry.el.openEnd,
          text: `${doc.eol}${indent}${doc.indentUnit}<Filter>${escapeText(filter)}</Filter>`,
        },
      ])
    }
  }

  addFilter(path: string): void {
    this.requireFilters()
    const p = toBackslash(path)
    const existing = new Set(this.filters.map((f) => key(f.path)))
    if (existing.has(key(p))) throw new Error(`filter ${p} already exists`)

    const segments = p.split('\\')
    for (let i = 1; i <= segments.length; i++) {
      const ancestor = segments.slice(0, i).join('\\')
      if (existing.has(key(ancestor))) continue
      const guid = this.newGuid()
      this.insert(
        this.filtersDoc!,
        'Filter',
        (indent, eol, unit) =>
          `<Filter Include="${escapeAttr(ancestor)}">${eol}${indent}${unit}` +
          `<UniqueIdentifier>${guid}</UniqueIdentifier>${eol}${indent}</Filter>`,
      )
      existing.add(key(ancestor))
    }
  }

  removeFilter(path: string, options?: { reparentTo?: string | null }): void {
    this.requireFilters()
    const p = toBackslash(path)
    if (!this.filters.some((f) => key(f.path) === key(p))) throw new Error(`no filter named ${p}`)

    const descendants = this.filters.filter((f) => isSelfOrDescendant(f.path, p))
    const contained = this.files.filter((f) => f.filter !== null && isSelfOrDescendant(f.filter, p))
    if (options === undefined && (descendants.length > 1 || contained.length > 0)) {
      throw new Error(`filter ${p} is not empty`)
    }

    const reparentTo = options?.reparentTo ?? null
    for (const file of contained) this.moveToFilter(file.path, reparentTo)
    // Deepest first, so each removal sees a filter with nothing left under it.
    for (const filter of [...descendants].sort((a, b) => b.path.length - a.path.length)) {
      const item = this.findItem(this.filtersDoc!, filter.path, 'Filter')
      if (item) this.remove(this.filtersDoc!, item)
    }
  }

  renameFilter(path: string, newName: string): void {
    this.requireFilters()
    const doc = this.filtersDoc!
    const from = toBackslash(path)
    if (!this.filters.some((f) => key(f.path) === key(from))) throw new Error(`no filter named ${from}`)
    if (newName.includes('\\')) throw new Error('a new filter name is a single segment')

    const cut = from.lastIndexOf('\\')
    const to = cut < 0 ? newName : `${from.slice(0, cut)}\\${newName}`
    const rewrite = (value: string) => to + value.slice(from.length)

    const splices: Splice[] = []
    for (const item of this.items(doc, 'Filter')) {
      if (!isSelfOrDescendant(item.include, from)) continue
      const include = attr(item.el, 'Include')!
      splices.push({ start: include.valueStart, end: include.valueEnd, text: escapeAttr(rewrite(item.include)) })
    }
    for (const item of this.items(doc)) {
      const child = childElements(item.el, 'Filter')[0]
      if (!child) continue
      const value = doc.text.slice(child.openEnd, child.closeStart)
      if (!isSelfOrDescendant(value, from)) continue
      splices.push({ start: child.openEnd, end: child.closeStart, text: escapeText(rewrite(value)) })
    }
    doc.edit(splices)
  }

  // ----------------------------------------------------------- references

  async addReference(otherVcxprojPath: string): Promise<void> {
    const target = resolve(otherVcxprojPath)
    const include = toBackslash(relative(this.dir, target))
    if (this.references.some((r) => key(r.include) === key(include))) {
      throw new Error(`${include} is already referenced`)
    }
    const other = parseXml(await readFile(target, 'utf8'))
    const guid = projectGuidOf(other)
    this.insert(
      this.vcxproj,
      'ProjectReference',
      (indent, eol, unit) =>
        `<ProjectReference Include="${escapeAttr(include)}">${eol}${indent}${unit}` +
        `<Project>${guid}</Project>${eol}${indent}</ProjectReference>`,
    )
  }

  removeReference(include: string): void {
    const item = this.findItem(this.vcxproj, toBackslash(include), 'ProjectReference')
    if (!item) throw new Error(`${include} is not referenced`)
    this.remove(this.vcxproj, item)
  }

  // ---------------------------------------------------------------- save

  async save(): Promise<void> {
    await this.vcxproj.save()
    await this.filtersDoc?.save()
  }

  // ------------------------------------------------------------ internals

  private requireFilters(): void {
    if (!this.filtersDoc) throw new Error(`${this.name} has no .vcxproj.filters file`)
  }

  private requireFilterExists(filter: string): void {
    if (!this.filters.some((f) => key(f.path) === key(toBackslash(filter)))) {
      throw new Error(`no filter named ${filter}`)
    }
  }

  private filterAssignments(): Map<string, string> {
    const map = new Map<string, string>()
    if (!this.filtersDoc) return map
    for (const item of this.items(this.filtersDoc)) {
      const child = childElements(item.el, 'Filter')[0]
      if (child) map.set(key(item.include), this.filtersDoc.text.slice(child.openEnd, child.closeStart))
    }
    return map
  }

  /**
   * ItemGroup children carrying an `Include`. With no `name`, this is every file
   * item: a whitelist of element names is hopeless, since projects invent their own
   * (FilesToPackage, OtherWpp, Wmimofck...), so non-file items are blacklisted.
   */
  private items(doc: Doc, name?: string): Item[] {
    const out: Item[] = []
    for (const group of childElements(doc.root, 'ItemGroup')) {
      for (const el of childElements(group, name)) {
        if (name === undefined && NON_FILE_ITEMS.has(el.name)) continue
        const include = attr(el, 'Include')
        if (!include) continue
        out.push({ el, group, include: unescapeXml(include.rawValue) })
      }
    }
    return out
  }

  private findItem(doc: Doc, include: string, name?: string): Item | undefined {
    return this.items(doc, name).find((i) => key(i.include) === key(include))
  }

  private childText(doc: Doc, el: XmlElement, name: string): string | null {
    const child = childElements(el, name)[0]
    return child ? doc.text.slice(child.openEnd, child.closeStart).trim() : null
  }

  private insertFilterEntry(path: string, itemType: string, filter: string): void {
    this.insert(
      this.filtersDoc!,
      itemType,
      (indent, eol, unit) =>
        `<${itemType} Include="${escapeAttr(path)}">${eol}${indent}${unit}` +
        `<Filter>${escapeText(filter)}</Filter>${eol}${indent}</${itemType}>`,
    )
  }

  /**
   * Appends an item to the last ItemGroup that already holds that item type, or, if
   * there is none, to a fresh ItemGroup after the last one in the file. Indentation
   * and line endings are copied from whatever is already there.
   */
  private insert(doc: Doc, itemType: string, build: (indent: string, eol: string, unit: string) => string): void {
    const eol = doc.eol
    const unit = doc.indentUnit
    const groups = childElements(doc.root, 'ItemGroup')

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!
      const siblings = childElements(group, itemType)
      const anchor = siblings[siblings.length - 1]
      if (!anchor) continue
      const indent = lineIndent(doc.text, anchor.start)
      doc.edit([{ start: anchor.end, end: anchor.end, text: `${eol}${indent}${build(indent, eol, unit)}` }])
      return
    }

    const anchor = groups[groups.length - 1] ?? childElements(doc.root).at(-1)
    if (!anchor) throw new Error(`${basename(doc.path)} has nowhere to put an ItemGroup`)
    const indent = lineIndent(doc.text, anchor.start)
    const inner = indent + unit
    doc.edit([
      {
        start: anchor.end,
        end: anchor.end,
        text:
          `${eol}${indent}<ItemGroup>` +
          `${eol}${inner}${build(inner, eol, unit)}` +
          `${eol}${indent}</ItemGroup>`,
      },
    ])
  }

  /**
   * Removes an item, and the ItemGroup with it if that leaves the group empty and
   * unlabelled. Removing the group is what makes add-then-remove byte-identical when
   * the add had to create one.
   */
  private remove(doc: Doc, item: Item): void {
    const lastOne = childElements(item.group).length === 1 && item.group.attrs.length === 0
    doc.edit([deleteWholeLines(doc.text, lastOne ? item.group : item.el)])
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Deletes an element along with the line it sits on, when it has that line to
 * itself: the preceding line ending and indentation go too, which is exactly the
 * inverse of how `insert` adds one.
 */
function deleteWholeLines(source: string, el: XmlElement): Splice {
  const lineStart = source.lastIndexOf('\n', Math.max(0, el.start - 1)) + 1
  const before = source.slice(lineStart, el.start)
  let after = el.end
  while (after < source.length && (source[after] === ' ' || source[after] === '\t')) after++
  const atLineEnd = after >= source.length || source[after] === '\r' || source[after] === '\n'
  if (before.trim() !== '' || !atLineEnd) return { start: el.start, end: el.end, text: '' }

  const eolLength = lineStart >= 2 && source[lineStart - 2] === '\r' ? 2 : lineStart >= 1 ? 1 : 0
  return { start: lineStart - eolLength, end: after, text: '' }
}

function projectGuidOf(doc: XmlDocument): string {
  const root = doc.children.find((c): c is XmlElement => c.kind === 'element' && c.name === 'Project')
  if (!root) throw new Error('referenced project has no <Project> root element')
  for (const group of childElements(root, 'PropertyGroup')) {
    const el = childElements(group, 'ProjectGuid')[0]
    if (el) return doc.source.slice(el.openEnd, el.closeStart).trim()
  }
  throw new Error('referenced project has no <ProjectGuid>')
}

const isSelfOrDescendant = (candidate: string, ancestor: string) =>
  key(candidate) === key(ancestor) || key(candidate).startsWith(key(ancestor) + '\\')

/** Windows path semantics: separator- and case-insensitive comparison. */
const key = (path: string) => toBackslash(path).toLowerCase()

const toBackslash = (path: string) => path.replaceAll('/', '\\')

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

const escapeText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const unescapeXml = (value: string) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

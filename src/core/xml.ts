import { lineColumn } from './text.js'

/**
 * A CST for the XML dialect MSBuild project files are written in.
 *
 * Every node carries offsets into the original source, and the nodes tile the
 * source completely: no byte belongs to nothing. That is what makes splice-based
 * editing safe — anything we do not deliberately replace stays the same bytes.
 *
 * Deliberately not supported: DTDs, namespace resolution, entity expansion.
 */

export type XmlNode = XmlElement | XmlText | XmlComment | XmlCData | XmlDecl

export interface XmlElement {
  kind: 'element'
  name: string
  attrs: XmlAttr[]
  children: XmlNode[]
  selfClosing: boolean
  /** Offset of `<`. */
  start: number
  /** Offset just past the final `>`. */
  end: number
  /** Offset just past the `>` of the open tag. */
  openEnd: number
  /** Offset of the `<` of the close tag; equals `end` when self-closing. */
  closeStart: number
}

export interface XmlAttr {
  name: string
  /** The value exactly as written, entities and all, without the quotes. */
  rawValue: string
  quote: '"' | "'"
  start: number
  end: number
  valueStart: number
  valueEnd: number
}

export interface XmlText {
  kind: 'text'
  start: number
  end: number
}
export interface XmlComment {
  kind: 'comment'
  start: number
  end: number
}
export interface XmlCData {
  kind: 'cdata'
  start: number
  end: number
}
export interface XmlDecl {
  kind: 'decl'
  start: number
  end: number
}

export interface XmlDocument {
  source: string
  /** '﻿' or ''. Part of `source`; never stripped. */
  bom: string
  children: XmlNode[]
}

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'XmlParseError'
  }
}

const BOM = '﻿'

export function parseXml(source: string): XmlDocument {
  const bom = source.startsWith(BOM) ? BOM : ''
  const p = new Parser(source)
  p.pos = bom.length
  const children = p.parseNodes(null)
  return { source, bom, children }
}

const isNameStart = (c: string | undefined) =>
  c !== undefined && (/[A-Za-z_:]/.test(c))
const isNameChar = (c: string | undefined) =>
  c !== undefined && (/[A-Za-z0-9_:.\-]/.test(c))
const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\r' || c === '\n'

class Parser {
  pos = 0
  constructor(readonly src: string) {}

  fail(message: string, at = this.pos): never {
    const { line, column } = lineColumn(this.src, at)
    throw new XmlParseError(message, at, line, column)
  }

  /** Parses siblings until EOF, or until the close tag of `parent`. */
  parseNodes(parent: string | null): XmlNode[] {
    const nodes: XmlNode[] = []
    for (;;) {
      if (this.pos >= this.src.length) {
        if (parent !== null) this.fail(`unclosed element <${parent}>`)
        return nodes
      }
      if (this.src[this.pos] === '<') {
        if (this.src.startsWith('</', this.pos)) {
          if (parent === null) this.fail('unexpected close tag')
          return nodes
        }
        nodes.push(this.parseMarkup())
      } else {
        nodes.push(this.parseText())
      }
    }
  }

  parseText(): XmlText {
    const start = this.pos
    const next = this.src.indexOf('<', this.pos)
    this.pos = next < 0 ? this.src.length : next
    return { kind: 'text', start, end: this.pos }
  }

  parseMarkup(): XmlNode {
    const start = this.pos
    if (this.src.startsWith('<!--', start)) return { kind: 'comment', start, end: this.until('-->', start, 'unterminated comment') }
    if (this.src.startsWith('<![CDATA[', start)) return { kind: 'cdata', start, end: this.until(']]>', start, 'unterminated CDATA section') }
    if (this.src.startsWith('<?', start)) return { kind: 'decl', start, end: this.until('?>', start, 'unterminated processing instruction') }
    if (this.src.startsWith('<!', start)) {
      this.fail(this.src.startsWith('<!DOCTYPE', start) ? 'DOCTYPE is not supported' : 'unsupported declaration', start)
    }
    return this.parseElement()
  }

  until(terminator: string, start: number, message: string): number {
    const i = this.src.indexOf(terminator, start)
    if (i < 0) this.fail(message, start)
    this.pos = i + terminator.length
    return this.pos
  }

  parseElement(): XmlElement {
    const start = this.pos
    this.pos++ // '<'
    const name = this.parseName('element name')
    const attrs: XmlAttr[] = []
    for (;;) {
      this.skipSpace()
      const c = this.src[this.pos]
      if (c === undefined) this.fail(`unclosed element <${name}>`, start)
      if (c === '>' || this.src.startsWith('/>', this.pos)) break
      attrs.push(this.parseAttr())
    }

    if (this.src.startsWith('/>', this.pos)) {
      this.pos += 2
      const end = this.pos
      return { kind: 'element', name, attrs, children: [], selfClosing: true, start, end, openEnd: end, closeStart: end }
    }

    this.pos++ // '>'
    const openEnd = this.pos
    const children = this.parseNodes(name)
    const closeStart = this.pos
    this.pos += 2 // '</'
    const closeName = this.parseName('close tag name')
    if (closeName !== name) this.fail(`</${closeName}> closes <${name}>`, closeStart)
    this.skipSpace()
    if (this.src[this.pos] !== '>') this.fail(`malformed close tag for <${name}>`, closeStart)
    this.pos++
    return { kind: 'element', name, attrs, children, selfClosing: false, start, end: this.pos, openEnd, closeStart }
  }

  parseName(what: string): string {
    const start = this.pos
    if (!isNameStart(this.src[this.pos])) this.fail(`expected ${what}`)
    while (isNameChar(this.src[this.pos])) this.pos++
    return this.src.slice(start, this.pos)
  }

  parseAttr(): XmlAttr {
    const start = this.pos
    const name = this.parseName('attribute name')
    this.skipSpace()
    if (this.src[this.pos] !== '=') this.fail(`expected '=' after attribute ${name}`)
    this.pos++
    this.skipSpace()
    const quote = this.src[this.pos]
    if (quote !== '"' && quote !== "'") this.fail(`expected a quoted value for attribute ${name}`)
    this.pos++
    const valueStart = this.pos
    const close = this.src.indexOf(quote, this.pos)
    if (close < 0) this.fail(`unterminated attribute value for ${name}`, start)
    this.pos = close + 1
    return { name, rawValue: this.src.slice(valueStart, close), quote, start, end: this.pos, valueStart, valueEnd: close }
  }

  skipSpace(): void {
    while (isSpace(this.src[this.pos])) this.pos++
  }
}

/** Depth-first walk over every element in the document. */
export function* elements(node: XmlDocument | XmlElement): Generator<XmlElement> {
  for (const child of node.children) {
    if (child.kind === 'element') {
      yield child
      yield* elements(child)
    }
  }
}

/** Direct element children with the given name. */
export function childElements(parent: XmlDocument | XmlElement, name?: string): XmlElement[] {
  return parent.children.filter(
    (c): c is XmlElement => c.kind === 'element' && (name === undefined || c.name === name),
  )
}

export function attr(el: XmlElement, name: string): XmlAttr | undefined {
  return el.attrs.find((a) => a.name === name)
}

/** The raw text between an element's tags, entities and all. */
export function rawText(doc: XmlDocument, el: XmlElement): string {
  return doc.source.slice(el.openEnd, el.closeStart)
}

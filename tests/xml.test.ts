import { describe, expect, it } from 'vitest'
import { parseXml, XmlParseError, type XmlElement } from '../src/core/xml.js'
import { checkCoverage } from './helpers/coverage.js'

const roundTrips = (src: string) => {
  const doc = parseXml(src)
  checkCoverage(doc)
  return doc
}

describe('parseXml', () => {
  it('preserves a UTF-8 BOM', () => {
    const doc = roundTrips('﻿<Project />')
    expect(doc.bom).toBe('﻿')
  })

  it('parses with no BOM', () => {
    expect(roundTrips('<Project />').bom).toBe('')
  })

  it('keeps the xml declaration as a node', () => {
    const doc = roundTrips('<?xml version="1.0" encoding="utf-8"?>\n<Project />')
    expect(doc.children[0]!.kind).toBe('decl')
  })

  it('parses a self-closing element with attributes', () => {
    const doc = roundTrips('<ItemGroup Label="ProjectConfigurations" />')
    const el = doc.children[0] as XmlElement
    expect(el.kind).toBe('element')
    expect(el.name).toBe('ItemGroup')
    expect(el.selfClosing).toBe(true)
    expect(el.attrs).toHaveLength(1)
    expect(el.attrs[0]!.name).toBe('Label')
    expect(el.attrs[0]!.rawValue).toBe('ProjectConfigurations')
    expect(el.attrs[0]!.quote).toBe('"')
  })

  it('parses single-quoted attribute values', () => {
    const el = roundTrips("<X a='b' />").children[0] as XmlElement
    expect(el.attrs[0]!.quote).toBe("'")
    expect(el.attrs[0]!.rawValue).toBe('b')
  })

  it('records attribute value offsets', () => {
    const src = '<X Include="foo\\bar.cpp" />'
    const el = roundTrips(src).children[0] as XmlElement
    const a = el.attrs[0]!
    expect(src.slice(a.valueStart, a.valueEnd)).toBe('foo\\bar.cpp')
    expect(src.slice(a.start, a.end)).toBe('Include="foo\\bar.cpp"')
  })

  it('keeps entities encoded in attribute values', () => {
    const el = roundTrips('<X c="a &amp; b" />').children[0] as XmlElement
    expect(el.attrs[0]!.rawValue).toBe('a &amp; b')
  })

  it('parses nested elements and text', () => {
    const doc = roundTrips('<A>\n  <B>text</B>\n</A>')
    const a = doc.children[0] as XmlElement
    const b = a.children.find((c) => c.kind === 'element') as XmlElement
    expect(b.name).toBe('B')
    expect(b.children).toHaveLength(1)
    expect(b.children[0]!.kind).toBe('text')
  })

  it('records openEnd and closeStart', () => {
    const src = '<A><B /></A>'
    const a = roundTrips(src).children[0] as XmlElement
    expect(src.slice(a.openEnd, a.closeStart)).toBe('<B />')
  })

  it('parses comments', () => {
    const doc = roundTrips('<!-- hi --><A />')
    expect(doc.children[0]!.kind).toBe('comment')
  })

  it('passes CDATA through opaquely', () => {
    const doc = roundTrips('<A><![CDATA[ <not-a-tag> ]]></A>')
    const a = doc.children[0] as XmlElement
    expect(a.children[0]!.kind).toBe('cdata')
  })

  it('handles attributes split across lines', () => {
    const el = roundTrips('<X\n  a="1"\n  b="2"\n/>').children[0] as XmlElement
    expect(el.attrs.map((a) => a.name)).toEqual(['a', 'b'])
  })

  it('handles dotted, dashed and namespaced names', () => {
    const el = roundTrips('<a.b-c:d xml:space="preserve" />').children[0] as XmlElement
    expect(el.name).toBe('a.b-c:d')
    expect(el.attrs[0]!.name).toBe('xml:space')
  })

  it('parses an empty non-self-closing element', () => {
    const el = roundTrips('<A></A>').children[0] as XmlElement
    expect(el.children).toHaveLength(0)
    expect(el.selfClosing).toBe(false)
  })
})

describe('parseXml errors', () => {
  const err = (src: string) => {
    try {
      parseXml(src)
    } catch (e) {
      return e as XmlParseError
    }
    throw new Error('expected a parse error')
  }

  it('throws on an unclosed tag', () => {
    expect(err('<A>').message).toMatch(/unclosed/i)
  })

  it('throws on a mismatched close tag', () => {
    const e = err('<A></B>')
    expect(e.message).toMatch(/</)
    expect(e.line).toBe(1)
  })

  it('throws on an unterminated attribute value', () => {
    expect(err('<A x="oops />').message).toMatch(/attribute|quote/i)
  })

  it('throws on a stray close tag', () => {
    expect(err('</A>').message).toMatch(/close/i)
  })

  it('throws on DOCTYPE', () => {
    expect(err('<!DOCTYPE html><A />').message).toMatch(/doctype/i)
  })

  it('reports line and column', () => {
    const e = err('<A>\n  <B>\n</A>')
    expect(e.line).toBeGreaterThan(1)
    expect(e.column).toBeGreaterThan(0)
    expect(e.offset).toBeGreaterThan(0)
  })
})

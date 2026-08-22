import { expect } from 'vitest'
import type { XmlDocument, XmlNode } from '../../src/core/xml.js'

/**
 * The CST is only safe to splice if it tiles the source completely: every byte of
 * the file belongs to exactly one node, and every element's children tile the span
 * between its open and close tags. If that holds, `source` is trivially the
 * round-trip, and no edit can silently drop bytes.
 */
export function checkCoverage(doc: XmlDocument): void {
  expect(doc.source.startsWith(doc.bom)).toBe(true)
  tile(doc.source, doc.children, doc.bom.length, doc.source.length, 'document')
}

function tile(source: string, nodes: XmlNode[], start: number, end: number, where: string): void {
  let pos = start
  for (const node of nodes) {
    expect(node.start, `${where}: gap or overlap before ${node.kind}`).toBe(pos)
    expect(node.end).toBeGreaterThanOrEqual(node.start)
    if (node.kind === 'element') {
      expect(node.openEnd).toBeGreaterThan(node.start)
      expect(node.closeStart).toBeGreaterThanOrEqual(node.openEnd)
      expect(node.closeStart).toBeLessThanOrEqual(node.end)
      tile(source, node.children, node.openEnd, node.closeStart, `<${node.name}>`)
      for (const attr of node.attrs) {
        expect(attr.start).toBeGreaterThanOrEqual(node.start)
        expect(attr.end).toBeLessThanOrEqual(node.openEnd)
        expect(source.slice(attr.valueStart, attr.valueEnd)).toBe(attr.rawValue)
      }
    }
    pos = node.end
  }
  expect(pos, `${where}: trailing bytes uncovered`).toBe(end)
}

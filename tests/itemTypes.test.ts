import { describe, expect, it } from 'vitest'
import { itemTypeFor } from '../src/core/itemTypes.js'

describe('itemTypeFor', () => {
  it.each([
    ['main.cpp', 'ClCompile'],
    ['main.c', 'ClCompile'],
    ['a.cxx', 'ClCompile'],
    ['a.cc', 'ClCompile'],
    ['a.h', 'ClInclude'],
    ['a.hpp', 'ClInclude'],
    ['a.inl', 'ClInclude'],
    ['a.rc', 'ResourceCompile'],
    ['a.idl', 'Midl'],
    ['driver.inx', 'Inf'],
    ['driver.inf', 'Inf'],
    ['events.mc', 'MessageCompile'],
    ['boot.asm', 'MASM'],
    ['icon.ico', 'Image'],
    ['readme.txt', 'Text'],
    ['app.manifest', 'Manifest'],
  ])('maps %s to %s', (path, expected) => {
    expect(itemTypeFor(path)).toBe(expected)
  })

  it('is case-insensitive about the extension', () => {
    expect(itemTypeFor('MAIN.CPP')).toBe('ClCompile')
  })

  it('falls back to None for obscure and missing extensions', () => {
    expect(itemTypeFor('blob.bin')).toBe('None')
    expect(itemTypeFor('data.wibble')).toBe('None')
    expect(itemTypeFor('Makefile')).toBe('None')
  })

  it('uses the last extension of a path with directories', () => {
    expect(itemTypeFor('src\\sub.dir\\a.cpp')).toBe('ClCompile')
  })
})

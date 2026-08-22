/**
 * Extension -> MSBuild item element name, mirroring Visual Studio's defaults for a
 * C++ project. Used only when *adding* a file; existing items keep whatever element
 * name they already have, however exotic (the sample corpus alone contains
 * FilesToPackage, OtherWpp, Wmimofck, MASM, Ctrpp and friends).
 */
const BY_EXTENSION: Record<string, string> = {}

const assign = (itemType: string, extensions: string) => {
  for (const ext of extensions.split(/\s+/)) if (ext) BY_EXTENSION[ext] = itemType
}

assign('ClCompile', 'c cc cpp cxx c++ cp cppm ixx def odl asm asmx')
assign('ClInclude', 'h hh hpp hxx h++ hm inl inc ipp ixx.h tlh tli xsd')
assign('ResourceCompile', 'rc rc2')
assign('Midl', 'idl')
assign('Inf', 'inf inx inv')
assign('MessageCompile', 'mc man')
assign('MASM', 's')
assign('Image', 'ico cur bmp png gif jpg jpeg jpe tif tiff dib rle emf wmf')
assign('Text', 'txt')
assign('Xml', 'xml xsl xslt xsd.xml')
assign('Manifest', 'manifest')
assign('Natvis', 'natvis')

// 'asm' belongs to MASM in a driver project but ClCompile in VS's stock C++ defaults.
// Drivers are the target audience, so MASM wins.
assign('MASM', 'asm')

/** Item element name for a path. Anything unrecognised is `None`, by design. */
export function itemTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'None'
  const ext = path.slice(dot + 1).toLowerCase()
  return BY_EXTENSION[ext] ?? 'None'
}

/**
 * ItemGroup children that are not files. Everything else with an `Include`
 * attribute is treated as a file item, whatever its element name.
 */
export const NON_FILE_ITEMS = new Set([
  'ProjectConfiguration',
  'ProjectReference',
  'Reference',
  'COMReference',
  'BuildMacro',
  'ProjectCapability',
  'ProjectTools',
  'Filter',
  'PackageReference',
])

// Match the Node TypeScript host, including truncation of an odd UTF-16 tail.
export function typeScriptBomText(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.toString('utf16le', 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return Buffer.from(bytes.subarray(2, bytes.length & ~1))
      .swap16()
      .toString('utf16le');
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.toString('utf8', 3)
    : undefined;
}

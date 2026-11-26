import { statSync } from 'node:fs';

export function physicalEntry(file: string): unknown {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat === undefined
    ? null
    : [
        stat.dev.toString(),
        stat.ino.toString(),
        // Installers can overwrite a manifest in place and restore its archive mtime.
        stat.isFile()
          ? [stat.mtimeNs.toString(), stat.ctimeNs.toString()]
          : null,
      ];
}

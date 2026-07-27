import { unpack } from '@publint/pack';
import type {
  PackedPackage,
  PackedPackageContentFile,
} from '../consistency/types';

export async function unpackPackedPackage(
  tarball: Buffer,
): Promise<PackedPackage> {
  return (await unpack(tarball)) as PackedPackage;
}

function toContentFile(options: {
  file: PackedPackage['files'][number];
  rootPrefix: string;
}): PackedPackageContentFile | null {
  if (!options.file.name.startsWith(options.rootPrefix)) return null;
  return {
    data: options.file.data,
    relativePath: options.file.name
      .slice(options.rootPrefix.length)
      .replaceAll('\\', '/'),
  };
}

export function getPackedContentFiles(
  packedPackage: PackedPackage,
): PackedPackageContentFile[] {
  const rootPrefix = `${packedPackage.rootDir}/`;
  return packedPackage.files.flatMap((file) => {
    const contentFile = toContentFile({ file, rootPrefix });
    return contentFile === null ? [] : [contentFile];
  });
}

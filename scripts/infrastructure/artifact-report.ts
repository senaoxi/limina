import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePublicationTarget } from '../release/publication';
import {
  discoverReleasePackages,
  getNpmCommand,
  ReleaseLogger,
  REPO_ROOT,
  runCommand,
} from '../release/shared';
import {
  createPackageSbom,
  readBundledInventory,
  type PublishedManifest,
} from './artifacts';

const outputDirectory = path.join(REPO_ROOT, '.reports/release');
await mkdir(outputDirectory, { recursive: true });
const reports = [];
for (const config of discoverReleasePackages()) {
  const manifest = JSON.parse(
    await readFile(path.join(config.publishDir, 'package.json'), 'utf8'),
  ) as PublishedManifest;
  validatePublicationTarget(
    config,
    manifest.version,
    `limina/v${manifest.version}`,
  );
  const inventoryText = await readFile(
    path.join(config.publishDir, 'bundled-dependencies.json'),
    'utf8',
  );
  const inventory = readBundledInventory(
    JSON.parse(inventoryText),
    manifest.name,
  );
  const packed = JSON.parse(
    runCommand(
      getNpmCommand(),
      ['pack', '--json', '--pack-destination', outputDirectory],
      { cwd: config.publishDir },
    ),
  ) as {
    filename: string;
    integrity: string;
    size: number;
    unpackedSize: number;
    files: { path: string }[];
  }[];
  const archive = packed[0];
  if (
    !archive ||
    packed.length !== 1 ||
    archive.filename !== `${manifest.name}-${manifest.version}.tgz` ||
    archive.files.every((file) => file.path !== 'bundled-dependencies.json')
  ) {
    throw new Error(
      'npm pack did not produce the expected package and bundled inventory.',
    );
  }
  const archivePath = path.join(outputDirectory, archive.filename);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(archivePath))
    .digest('base64')}`;
  if (
    integrity !== archive.integrity ||
    (await stat(archivePath)).size !== archive.size
  ) {
    throw new Error(
      'Packed artifact integrity or size differs from npm metadata.',
    );
  }
  await writeFile(
    path.join(outputDirectory, `${manifest.name}.cdx.json`),
    `${JSON.stringify(createPackageSbom(manifest, inventory, integrity), null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDirectory, `${manifest.name}.licenses.json`),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  reports.push({
    name: manifest.name,
    version: manifest.version,
    filename: archive.filename,
    integrity,
    packedBytes: archive.size,
    unpackedBytes: archive.unpackedSize,
    bundledDependencies: inventory.length,
  });
}
await writeFile(
  path.join(outputDirectory, 'artifacts.json'),
  `${JSON.stringify(reports, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, 'README.md'),
  [
    '# Limina release artifacts',
    '',
    '| Package | Version | Tarball bytes | Unpacked bytes | Bundled dependencies |',
    '| --- | --- | ---: | ---: | ---: |',
    ...reports.map(
      (report) =>
        `| ${report.name} | ${report.version} | ${report.packedBytes} | ${report.unpackedBytes} | ${report.bundledDependencies} |`,
    ),
    '',
    'Tarball sizes are actual npm pack gzip archive sizes. Integrity is independently recomputed from archive bytes.',
    '',
    'Each CycloneDX SBOM covers bundled code and records declared external requirements. Consumer-selected versions and external transitive dependencies are not inferred.',
    '',
    'The license gate uses the existing bundled-license policy. Development dependencies that enter the bundle are included.',
    '',
  ].join('\n'),
);
ReleaseLogger.info(`Artifact reports: ${outputDirectory}`);

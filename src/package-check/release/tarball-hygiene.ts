import path from 'pathe';
import { addTarballHygieneFinding } from './consistency/findings';
import type {
  PackedPackageContentFile,
  ReleaseConsistencyState,
} from './consistency/types';
import { hasSourceMappingUrlDirective } from './source-map-comments';

const REQUIRED_RELEASE_FILES = ['README.md', 'LICENSE.md'] as const;

function isJavaScriptPackageFile(relativePath: string): boolean {
  return /\.(?:cjs|mjs|js)$/u.test(relativePath);
}

function addMissingFilesFinding(options: {
  missingFiles: readonly string[];
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  addTarballHygieneFinding(options.state, {
    facts: {
      kind: 'required-files-missing',
      missingFiles: [...options.missingFiles],
      tarballPath: options.tarballPath,
    },
    filePath: options.packageManifestPath,
    message: `${options.rootPackageName}: tarball is missing required file(s): ${options.missingFiles.join(', ')}`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
  });
}

function addSourceMapFileFinding(options: {
  file: PackedPackageContentFile;
  outDir: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  addTarballHygieneFinding(options.state, {
    facts: {
      archiveEntryPath: options.file.relativePath,
      kind: 'source-map-file',
      tarballPath: options.tarballPath,
    },
    filePath: path.join(options.outDir, options.file.relativePath),
    message: `${options.rootPackageName}: tarball contains source map file: ${options.file.relativePath}`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
  });
}

function addSourceMappingUrlFinding(options: {
  file: PackedPackageContentFile;
  outDir: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  addTarballHygieneFinding(options.state, {
    facts: {
      archiveEntryPath: options.file.relativePath,
      kind: 'source-mapping-url',
      tarballPath: options.tarballPath,
    },
    filePath: path.join(options.outDir, options.file.relativePath),
    message: `${options.rootPackageName}: tarball JavaScript file contains sourceMappingURL directive: ${options.file.relativePath}`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
  });
}

function validateJavaScriptContent(options: {
  file: PackedPackageContentFile;
  outDir: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  if (!isJavaScriptPackageFile(options.file.relativePath)) return;
  const source = Buffer.from(options.file.data).toString('utf8');
  const hasDirective = hasSourceMappingUrlDirective(
    source,
    options.file.relativePath,
  );
  if (hasDirective) addSourceMappingUrlFinding(options);
}

function validateContentFile(options: {
  file: PackedPackageContentFile;
  outDir: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  if (/\.map$/u.test(options.file.relativePath)) {
    addSourceMapFileFinding(options);
    return;
  }
  validateJavaScriptContent(options);
}

export function validateReleaseTarballHygiene(options: {
  contentFiles: readonly PackedPackageContentFile[];
  outDir: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  const filePaths = new Set(
    options.contentFiles.map((file) => file.relativePath),
  );
  const missingFiles = REQUIRED_RELEASE_FILES.filter(
    (fileName) => !filePaths.has(fileName),
  );
  if (missingFiles.length > 0) {
    addMissingFilesFinding({ ...options, missingFiles });
  }
  for (const file of options.contentFiles) {
    validateContentFile({ ...options, file });
  }
}

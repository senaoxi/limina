import path from 'pathe';
import ts from 'typescript';
import { addTarballHygieneFinding } from './consistency/findings';
import type {
  PackedPackageContentFile,
  ReleaseConsistencyState,
} from './consistency/types';

const REQUIRED_RELEASE_FILES = ['README.md', 'LICENSE.md'] as const;
const SOURCE_MAPPING_URL_COMMENT_PATTERN = /^\s*#\s*sourceMappingURL\s*=/u;

function isJavaScriptPackageFile(relativePath: string): boolean {
  return /\.(?:cjs|mjs|js)$/u.test(relativePath);
}

function getCommentValue(token: ts.SyntaxKind, tokenText: string): string {
  if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
    return tokenText.slice(2);
  }
  return tokenText.slice(2, -2);
}

function commentContainsSourceMappingUrl(
  token: ts.SyntaxKind,
  tokenText: string,
): boolean {
  if (
    token !== ts.SyntaxKind.SingleLineCommentTrivia &&
    token !== ts.SyntaxKind.MultiLineCommentTrivia
  ) {
    return false;
  }
  return SOURCE_MAPPING_URL_COMMENT_PATTERN.test(
    getCommentValue(token, tokenText),
  );
}

function hasSourceMappingUrlDirective(source: string): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );

  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (commentContainsSourceMappingUrl(token, scanner.getTokenText())) {
      return true;
    }
  }

  return false;
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
  const hasDirective = hasSourceMappingUrlDirective(source);
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

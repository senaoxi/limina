import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import type ts from 'typescript';
import type {
  AstroMaterializedProject,
  AstroSemanticProject,
  AstroSemanticProjectSnapshotInput,
  AstroSemanticSeed,
  AstroSemanticToolchain,
} from './astro-semantic-types';

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeProjectReferences(
  references: readonly ts.ProjectReference[] | readonly string[] | undefined,
): readonly ts.ProjectReference[] | undefined {
  if (references === undefined) return undefined;
  return references
    .map((reference) =>
      typeof reference === 'string'
        ? { path: normalizeAbsolutePath(reference) }
        : {
            ...reference,
            path: normalizeAbsolutePath(reference.path),
          },
    )
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

export function createAstroSemanticProject(options: {
  analysisGeneration: number;
  configPath: string;
  overlayGeneration?: number;
  packageRootDir: string;
  projectFingerprint: string;
  readSnapshot: () => AstroSemanticProjectSnapshotInput;
}): AstroSemanticProject {
  const configPath = normalizeAbsolutePath(options.configPath);
  const packageRootDir = normalizeAbsolutePath(options.packageRootDir);
  const seedFields = {
    analysisGeneration: options.analysisGeneration,
    configPath,
    overlayGeneration: options.overlayGeneration ?? 0,
    packageRootDir,
    projectFingerprint: options.projectFingerprint,
  };
  const seed: AstroSemanticSeed = {
    ...seedFields,
    id: hashValue(seedFields),
  };
  return { readSnapshot: options.readSnapshot, seed };
}

export function materializeAstroSemanticProject(
  project: AstroSemanticProject,
): AstroMaterializedProject {
  const snapshot = project.readSnapshot();
  return {
    seed: project.seed,
    snapshot: {
      checkerExtensions: [
        ...new Set(snapshot.checkerExtensions.map((extension) => extension)),
      ].sort(),
      compilerOptions: { ...snapshot.compilerOptions },
      configClosure: snapshot.configClosure
        .map((entry) => ({
          contentHash: entry.contentHash,
          filePath: normalizeAbsolutePath(entry.filePath),
        }))
        .sort((left, right) =>
          left.filePath < right.filePath
            ? -1
            : left.filePath > right.filePath
              ? 1
              : 0,
        ),
      fileNames: [
        ...new Set(snapshot.fileNames.map(normalizeAbsolutePath)),
      ].sort(),
      projectReferences: normalizeProjectReferences(snapshot.projectReferences),
    },
  };
}

export function createAstroMaterializedIdentity(options: {
  project: AstroMaterializedProject;
  toolchain: AstroSemanticToolchain;
}): string {
  return hashValue({
    seed: options.project.seed,
    snapshot: options.project.snapshot,
    toolchainPaths: options.toolchain.paths,
    toolchainVersions: options.toolchain.versions,
  });
}

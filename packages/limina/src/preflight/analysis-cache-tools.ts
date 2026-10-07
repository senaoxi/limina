import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import { findNearestPackageManifest } from '../utils/governance-manifest';

const requireFromLimina = createRequire(import.meta.url);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const nativeExecutableName = process.platform === 'win32' ? 'tsgo.exe' : 'tsgo';
interface ToolFile {
  path: string;
  version: string;
  observation: string;
}
function observation(file: string): string {
  const stat = statSync(file);
  return analysisHash([pathBinding(file), stat.size, stat.mtimeMs]);
}
function capture(file: string): ToolFile {
  const before = observation(file);
  const version = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (observation(file) !== before)
    throw new Error('Analysis tool changed during observation.');
  return { path: file, version, observation: before };
}
function optionalFile(name: string, resolver = requireFromLimina): string[] {
  try {
    return [resolver.resolve(name)];
  } catch {
    return [];
  }
}
function nativeCheckerFiles(resolver = requireFromLimina): string[] {
  try {
    const manifest = resolver.resolve(
      '@typescript/native-preview/package.json',
    );
    const local = createRequire(manifest);
    const platform = local.resolve(
      `@typescript/native-preview-${process.platform}-${process.arch}/package.json`,
    );
    const binary = path.join(
      path.dirname(platform),
      'lib',
      nativeExecutableName,
    );
    return [
      manifest,
      path.join(path.dirname(manifest), 'lib/getExePath.js'),
      platform,
      binary,
    ];
  } catch {
    return [];
  }
}
function resolverFiles(): string[] {
  const files = optionalFile('oxc-resolver');
  if (files.length === 0) return files;
  requireFromLimina('oxc-resolver');
  const seen = new Set<string>();
  const pending = [requireFromLimina.cache[files[0]!]];
  while (pending.length > 0) collectModule(pending.pop(), seen, pending);
  return [...seen];
}
function collectModule(
  module: NodeJS.Module | undefined,
  seen: Set<string>,
  pending: (NodeJS.Module | undefined)[],
): void {
  if (module === undefined || seen.has(module.filename)) return;
  seen.add(module.filename);
  pending.push(...module.children);
}
function resolverSelection(): unknown {
  return [
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH,
    process.env.NAPI_RS_FORCE_WASI,
    process.env.OXC_RESOLVER_YARN_PNP,
  ];
}
export class AnalysisToolObservation {
  readonly #files: ToolFile[];
  readonly #selection: string;
  readonly #packageManifest: string;
  readonly identity: unknown;
  constructor(configPath?: string) {
    const packageManifest = findNearestPackageManifest(moduleDirectory);
    if (packageManifest === null)
      throw new Error('Cannot identify the package owning the analysis tools.');
    this.#packageManifest = packageManifest;
    const project =
      configPath === undefined ? requireFromLimina : createRequire(configPath);
    const files = [
      packageManifest,
      ...optionalFile('typescript'),
      ...optionalFile('typescript/lib/_tsc.js'),
      ...nativeCheckerFiles(),
      ...optionalFile('typescript', project),
      ...optionalFile('typescript/lib/_tsc.js', project),
      ...nativeCheckerFiles(project),
      ...resolverFiles(),
      process.execPath,
    ];
    this.#files = [...new Set(files)].map(capture);
    this.#selection = analysisHash(resolverSelection());
    this.identity = { files: this.#files, selection: this.#selection };
  }
  #assertFile(file: ToolFile): void {
    if (observation(file.path) !== file.observation)
      throw new Error(
        'Limina analysis tool identity changed during execution. Run the command again.',
      );
  }
  #assertPackageBinding(): void {
    if (findNearestPackageManifest(moduleDirectory) !== this.#packageManifest)
      throw new Error(
        'Analysis tool package binding changed. Run the command again.',
      );
  }
  assertStable(): void {
    this.#assertPackageBinding();
    if (analysisHash(resolverSelection()) !== this.#selection)
      throw new Error(
        'Analysis resolver selection changed. Run the command again.',
      );
    for (const file of this.#files) this.#assertFile(file);
  }
}
export function analysisToolIdentity(): unknown {
  return new AnalysisToolObservation().identity;
}

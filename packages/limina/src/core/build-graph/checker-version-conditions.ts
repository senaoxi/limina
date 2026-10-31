import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';

interface VersionCompiler {
  getConditions(
    options: ts.CompilerOptions,
    mode: ts.ResolutionMode,
  ): readonly string[];
  VersionRange: {
    tryParse(text: string): { test(version: string): boolean } | undefined;
  };
}

/** Compatibility guard, not a second resolver. Only conditions visited by the
 * compiler's actual request probe can limit the Native Checker qualification. */
export function resolveVersionQualifiedModule(input: {
  specifier: string;
  file: string;
  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  mode: ts.ResolutionMode;
  executionRoot?: string;
}): ts.ResolvedModuleFull | undefined {
  const conditions = new Set<string>();
  const manifests: unknown[] = [];
  const host = {
    ...input.host,
    trace: (text: string) => {
      const condition = /condition '(types@[^']+)'/.exec(text)?.[1];
      if (condition !== undefined) conditions.add(condition);
    },
    readFile: (file: string) => {
      const text = input.host.readFile(file);
      if (file.endsWith('/package.json') && text?.includes('types@')) {
        try {
          manifests.push(JSON.parse(text));
        } catch {
          // The compiler owns invalid manifests.
        }
      }
      return text;
    },
  };
  const result = ts.resolveModuleName(
    input.specifier,
    input.file,
    { ...input.options, traceResolution: true },
    host,
    undefined,
    undefined,
    input.mode,
  ).resolvedModule;
  if (conditions.size === 0) return result;
  const version = nativeVersion(input.executionRoot, input.host);
  const compiler = ts as unknown as VersionCompiler;
  const ranges = compiler.VersionRange;
  if (
    typeof ranges?.tryParse !== 'function' ||
    typeof compiler.getConditions !== 'function'
  )
    throw new DeclarationObservationUnavailable(
      'Compiler version-condition qualification is unavailable.',
    );
  const activeConditions = new Set(
    compiler.getConditions(input.options, input.mode),
  );
  // Include the absence of a matching branch in equivalence. The compiler
  // supplies request conditions and version matching; no target is resolved here.
  const hasVersionCoverage = (keys: readonly string[]): boolean =>
    [ts.version, version, version.replace(/[-+].*$/, '')].every((value) =>
      keys.some(
        (key) =>
          key === 'default' ||
          activeConditions.has(key) ||
          (activeConditions.has('types') &&
            key.startsWith('types@') &&
            ranges.tryParse(key.slice('types@'.length))?.test(value)),
      ),
    );
  for (const condition of conditions) {
    if (input.options.customConditions?.includes(condition)) continue;
    const range = ranges.tryParse(condition.slice('types@'.length));
    if (range === undefined) continue;
    const isSourceMatch = range.test(ts.version);
    // Preview and release-version comparisons must both preserve selection;
    // otherwise compatibility is unproved without a Native request adapter.
    const release = version.replace(/[-+].*$/, '');
    if (
      [version, release].every((value) => range.test(value) === isSourceMatch)
    )
      continue;
    if (
      manifests.length > 0 &&
      manifests.every((manifest) =>
        hasEquivalentBranches(manifest, condition, hasVersionCoverage),
      )
    )
      continue;
    throw new DeclarationObservationUnavailable(
      `Checker version condition is not qualified: ${condition}; TypeScript ${ts.version}, tsgo ${version}; ${input.file}: ${input.specifier}. Use equivalent type branches or the matching TypeScript Checker.`,
    );
  }
  return result;
}

function nativeVersion(
  root: string | undefined,
  host: ts.ModuleResolutionHost,
): string {
  try {
    if (root === undefined) throw new Error('Missing execution root.');
    const manifest = createRequire(path.join(root, 'package.json')).resolve(
      '@typescript/native-preview/package.json',
    );
    const value = JSON.parse(host.readFile(manifest) ?? '{}') as {
      version?: unknown;
    };
    if (typeof value.version === 'string' && /^7\.0\.0-/.test(value.version))
      return value.version;
  } catch {
    // An unavailable executable tuple cannot prove compatibility.
  }
  throw new DeclarationObservationUnavailable(
    'Cannot qualify the installed tsgo version for versioned types conditions.',
  );
}

function hasEquivalentBranches(
  value: unknown,
  condition: string,
  hasVersionCoverage: (keys: readonly string[]) => boolean,
): boolean {
  if (value === null || typeof value !== 'object') return true;
  const entries = Object.entries(value);
  const hasUnprovedOutcomes =
    Object.hasOwn(value, condition) &&
    (new Set(entries.map(([, target]) => JSON.stringify(target))).size > 1 ||
      !hasVersionCoverage(entries.map(([key]) => key)));
  return (
    !hasUnprovedOutcomes &&
    entries.every(([, target]) =>
      hasEquivalentBranches(target, condition, hasVersionCoverage),
    )
  );
}

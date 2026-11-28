import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { collectStronglyConnectedComponents } from '../utils/strongly-connected-components';
import {
  toPortablePath,
  toPortableRelativePath,
  toPortableRelativePaths,
} from './helpers/path';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.resolve(sourceRoot, '..');

type PackageImportTarget =
  | string
  | readonly PackageImportTarget[]
  | { readonly [key: string]: PackageImportTarget | null };

interface PackageResolutionManifest {
  readonly exports: Readonly<Record<string, PackageImportTarget | null>>;
  readonly imports: Readonly<Record<string, PackageImportTarget | null>>;
  readonly name: string;
}

async function collectProductionSourceFiles(
  directory = sourceRoot,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__'
          ? []
          : collectProductionSourceFiles(entryPath);
      }
      return entry.isFile() &&
        /\.(?:ts|mts|cts)$/u.test(entry.name) &&
        !/\.d\.[cm]?ts$/u.test(entry.name)
        ? [entryPath]
        : [];
    }),
  );
  return files.flat();
}

function getImportedLocalNames(
  sourceFile: ts.SourceFile,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isCallsAnyLocalName(
  sourceFile: ts.SourceFile,
  localNames: ReadonlySet<string>,
): boolean {
  let isFound = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      isFound = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return isFound;
}

async function findProductionCallers(importedName: string): Promise<string[]> {
  const callers: string[] = [];
  const directoryEntries1 = await collectProductionSourceFiles();
  for (const filePath of directoryEntries1) {
    const source = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const localNames = getImportedLocalNames(sourceFile, importedName);
    if (localNames.size > 0 && isCallsAnyLocalName(sourceFile, localNames)) {
      callers.push(toPortablePath(path.relative(sourceRoot, filePath)));
    }
  }
  return callers.sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
}

// Under verbatimModuleSyntax: true, TypeScript preserves every non-type-only
// import/export declaration at runtime, including `import {} from` and
// `import { type X } from` (emitted as `import {} from`).
function getRuntimeSpecifiers(
  sourceFile: ts.SourceFile,
  packageName: string,
): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  const packagePrefix = `${packageName}/`;
  return specifiers.filter(
    (specifier) =>
      specifier.startsWith('.') ||
      specifier.startsWith('#') ||
      specifier === packageName ||
      specifier.startsWith(packagePrefix),
  );
}

function isPackageTargetRecord(
  value: PackageImportTarget,
): value is Readonly<Record<string, PackageImportTarget | null>> {
  return typeof value === 'object' && !Array.isArray(value);
}

function normalizePackageExports(
  rawExports: PackageImportTarget | null | undefined,
): Readonly<Record<string, PackageImportTarget | null>> {
  if (rawExports === null || rawExports === undefined) return {};
  if (!isPackageTargetRecord(rawExports)) {
    return { '.': rawExports };
  }
  return Object.keys(rawExports).every((key) => key.startsWith('.'))
    ? rawExports
    : { '.': rawExports };
}

async function loadPackageManifest(): Promise<PackageResolutionManifest> {
  const raw = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    exports?: PackageImportTarget | null;
    imports?: Record<string, PackageImportTarget | null>;
    name?: string;
  };
  return {
    exports: normalizePackageExports(raw.exports),
    imports: raw.imports ?? {},
    name: raw.name ?? 'limina',
  };
}

function collectPackageTargetStrings(
  target: PackageImportTarget | null | undefined,
): string[] {
  if (target === null || target === undefined) return [];
  if (typeof target === 'string') return [target];
  const entries = Array.isArray(target) ? target : Object.values(target);
  return entries.flatMap((entry) => collectPackageTargetStrings(entry));
}

function mapRuntimeExtension(candidatePath: string): string[] | undefined {
  if (candidatePath.endsWith('.js')) {
    const stem = candidatePath.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (candidatePath.endsWith('.mjs')) {
    return [`${candidatePath.slice(0, -4)}.mts`];
  }
  return candidatePath.endsWith('.cjs')
    ? [`${candidatePath.slice(0, -4)}.cts`]
    : undefined;
}

function resolveCandidatePath(
  candidatePath: string,
  productionFiles: ReadonlySet<string>,
): string | undefined {
  if (productionFiles.has(candidatePath)) return candidatePath;
  const mapped = mapRuntimeExtension(candidatePath);
  if (mapped !== undefined) {
    return mapped.find((candidate) => productionFiles.has(candidate));
  }
  return [
    `${candidatePath}.ts`,
    `${candidatePath}.mts`,
    `${candidatePath}.cts`,
    path.join(candidatePath, 'index.ts'),
    path.join(candidatePath, 'index.mts'),
    path.join(candidatePath, 'index.cts'),
  ].find((candidate) => productionFiles.has(candidate));
}

function resolvePackageMapTarget(
  key: string,
  targetMap: Readonly<Record<string, PackageImportTarget | null>>,
  productionFiles: ReadonlySet<string>,
): string[] {
  if (Object.hasOwn(targetMap, key)) {
    return collectPackageTargetStrings(targetMap[key])
      .map((target) =>
        resolveCandidatePath(
          path.resolve(packageRoot, target),
          productionFiles,
        ),
      )
      .filter((resolved): resolved is string => resolved !== undefined);
  }
  const wildcardMatches = Object.entries(targetMap)
    .filter(([pattern]) => pattern.includes('*'))
    .flatMap(([pattern, target]) => {
      const [prefix, suffix] = pattern.split('*', 2);
      if (
        prefix === undefined ||
        suffix === undefined ||
        !key.startsWith(prefix) ||
        !key.endsWith(suffix) ||
        key.length < prefix.length + suffix.length
      ) {
        return [];
      }
      const matched = key.slice(prefix.length, key.length - suffix.length);
      return [{ prefix, suffix, matched, target }];
    })
    .sort(
      (left, right) =>
        right.prefix.length - left.prefix.length ||
        right.suffix.length - left.suffix.length,
    );
  const best = wildcardMatches[0];
  return best === undefined
    ? []
    : collectPackageTargetStrings(best.target)
        .map((target) =>
          resolveCandidatePath(
            path.resolve(
              packageRoot,
              target.replaceAll('*', () => best.matched),
            ),
            productionFiles,
          ),
        )
        .filter((resolved): resolved is string => resolved !== undefined);
}

function toPackageExportKey(
  specifier: string,
  packageName: string,
): string | undefined {
  if (specifier === packageName) return '.';
  const prefix = `${packageName}/`;
  return specifier.startsWith(prefix)
    ? `./${specifier.slice(prefix.length)}`
    : undefined;
}

function resolveProductionImport(
  importer: string,
  specifier: string,
  manifest: PackageResolutionManifest,
  productionFiles: ReadonlySet<string>,
): string[] {
  if (specifier.startsWith('#')) {
    return resolvePackageMapTarget(
      specifier,
      manifest.imports,
      productionFiles,
    );
  }
  const exportKey = toPackageExportKey(specifier, manifest.name);
  if (exportKey !== undefined) {
    return resolvePackageMapTarget(
      exportKey,
      manifest.exports,
      productionFiles,
    );
  }
  const resolved = resolveCandidatePath(
    path.resolve(path.dirname(importer), specifier),
    productionFiles,
  );
  return resolved === undefined ? [] : [resolved];
}

function buildRuntimeImportGraph(
  sourcesByFile: ReadonlyMap<string, string>,
  manifest: PackageResolutionManifest,
): {
  files: string[];
  neighbors: Map<string, string[]>;
} {
  const files = sourcesByFile.keys().toArray();
  const productionFiles = new Set(files);
  const neighbors = new Map<string, string[]>();
  for (const [filePath, source] of sourcesByFile) {
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    neighbors.set(filePath, [
      ...new Set(
        getRuntimeSpecifiers(sourceFile, manifest.name).flatMap((specifier) =>
          resolveProductionImport(
            filePath,
            specifier,
            manifest,
            productionFiles,
          ),
        ),
      ),
    ]);
  }
  return { files, neighbors };
}

async function collectRuntimeImportGraph(): Promise<{
  files: string[];
  neighbors: Map<string, string[]>;
}> {
  const [files, manifest] = await Promise.all([
    collectProductionSourceFiles(),
    loadPackageManifest(),
  ]);
  const sourcesByFile = new Map<string, string>();
  for (const filePath of files) {
    sourcesByFile.set(filePath, await readFile(filePath, 'utf8'));
  }
  return buildRuntimeImportGraph(sourcesByFile, manifest);
}

function findRuntimeImportCycles(
  files: readonly string[],
  neighbors: ReadonlyMap<string, readonly string[]>,
): string[][] {
  return collectStronglyConnectedComponents(
    files,
    (filePath) => neighbors.get(filePath) ?? [],
  )
    .filter(
      (component) =>
        component.length > 1 ||
        (component.length === 1 &&
          (neighbors.get(component[0]!) ?? []).includes(component[0]!)),
    )
    .map((component) =>
      component.map((filePath) =>
        toPortablePath(path.relative(sourceRoot, filePath)),
      ),
    );
}

async function collectRuntimeImportCycles(): Promise<string[][]> {
  const { files, neighbors } = await collectRuntimeImportGraph();
  return findRuntimeImportCycles(files, neighbors);
}

const higherCheckSubsystems = [
  'dependency-graph',
  'graph-check',
  'package-check',
  'proof',
  'source-check',
  'typecheck',
  'commands',
  'pipeline',
  'cli',
];

const forbiddenByLayer = new Map<string, ReadonlySet<string>>([
  [
    'check-reporting',
    new Set([
      'checker',
      'config',
      'core',
      'preflight',
      'execution',
      ...higherCheckSubsystems,
    ]),
  ],
  ['preflight', new Set(['execution', ...higherCheckSubsystems])],
  ['execution', new Set(higherCheckSubsystems)],
]);

function topLevelNode(filePath: string): string {
  const relative = toPortablePath(path.relative(sourceRoot, filePath));
  const slashIndex = relative.indexOf('/');
  return slashIndex === -1 ? relative : relative.slice(0, slashIndex);
}

function findUpwardLayerViolations(
  neighbors: ReadonlyMap<string, readonly string[]>,
): string[] {
  const violations: string[] = [];
  for (const [filePath, targets] of neighbors) {
    const relative = toPortablePath(path.relative(sourceRoot, filePath));
    if (!relative.includes('/')) continue;
    const [sourceLayer] = relative.split('/', 1);
    const forbidden = forbiddenByLayer.get(sourceLayer);
    if (forbidden === undefined) continue;
    for (const target of targets) {
      const relativeTarget = toPortablePath(path.relative(sourceRoot, target));
      if (!relativeTarget.includes('/')) continue;
      const [targetLayer] = relativeTarget.split('/', 1);
      if (forbidden.has(targetLayer)) {
        violations.push(`${relative} -> ${relativeTarget}`);
      }
    }
  }
  return violations;
}

function findUnexpectedTopLevelCycles(
  files: readonly string[],
  neighbors: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const layerNeighbors = new Map<string, Set<string>>();
  for (const filePath of files) {
    const fromLayer = topLevelNode(filePath);
    const targets = layerNeighbors.get(fromLayer) ?? new Set<string>();
    layerNeighbors.set(fromLayer, targets);
    const directTargets = neighbors.get(filePath) ?? [];
    for (const target of directTargets) {
      const toLayer = topLevelNode(target);
      if (toLayer !== fromLayer) {
        targets.add(toLayer);
      }
    }
  }
  return collectStronglyConnectedComponents(
    layerNeighbors.keys().toArray(),
    (layer) => [...(layerNeighbors.get(layer) ?? [])],
  )
    .filter((component) => component.length > 1)
    .map((component) =>
      component.toSorted(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    );
}

function findRuntimeImportPath(
  neighbors: ReadonlyMap<string, readonly string[]>,
  importer: string,
  destinations: ReadonlySet<string>,
): string[] | undefined {
  const previousByFile = new Map<string, string | undefined>([
    [importer, undefined],
  ]);
  const queue = [importer];
  let index = 0;
  while (index < queue.length) {
    const file = queue[index]!;
    index += 1;
    if (destinations.has(file)) {
      const route: string[] = [];
      for (
        let step: string | undefined = file;
        step !== undefined;
        step = previousByFile.get(step)
      ) {
        route.push(step);
      }
      return route.toReversed();
    }
    const targets = neighbors.get(file) ?? [];
    for (const target of targets) {
      if (previousByFile.has(target)) continue;
      previousByFile.set(target, file);
      queue.push(target);
    }
  }
  return undefined;
}

function findFactsImportsOfStageB2(
  neighbors: ReadonlyMap<string, readonly string[]>,
): string[] {
  const factsDirectory = path.join(sourceRoot, 'core/facts');
  const stageB2Entries = new Set(
    [
      'core/build-graph.ts',
      'core/build-graph/prepare.ts',
      'core/build-graph/reference-inference.ts',
      'core/build-graph/graph-validation.ts',
      'core/build-graph/finish-prepared-graph.ts',
    ].map((entry) => path.join(sourceRoot, entry)),
  );
  const violations: string[] = [];
  for (const importer of neighbors.keys()) {
    if (!importer.startsWith(`${factsDirectory}/`)) continue;
    const route = findRuntimeImportPath(neighbors, importer, stageB2Entries);
    if (route !== undefined) {
      violations.push(toPortableRelativePaths(sourceRoot, route).join(' -> '));
    }
  }
  return violations;
}

function findCoreBarrelImporters(
  neighbors: ReadonlyMap<string, readonly string[]>,
): string[] {
  const coreDirectory = path.join(sourceRoot, 'core');
  const barrel = path.join(coreDirectory, 'index.ts');
  return neighbors
    .entries()
    .filter(
      ([file, targets]) =>
        file !== barrel &&
        file.startsWith(`${coreDirectory}/`) &&
        targets.includes(barrel),
    )
    .map(([file]) => toPortableRelativePath(sourceRoot, file))
    .toArray();
}

describe('production architecture boundaries', () => {
  it('keeps relative, package-alias, and self-export runtime imports acyclic', async () => {
    await expect(collectRuntimeImportCycles()).resolves.toEqual([]);
  });

  it('detects runtime cycles across package aliases, self-exports, explicit .js paths, empty named imports/re-exports, and self-imports', async () => {
    const manifest = await loadPackageManifest();
    const runnerPath = path.join(sourceRoot, 'config/runner.ts');
    const checkerConfigPath = path.join(sourceRoot, 'checker/config.ts');
    const selfPath = path.join(sourceRoot, 'config/self.ts');

    const cyclesFor = (checkerConfigSource: string) => {
      const { files, neighbors } = buildRuntimeImportGraph(
        new Map([
          [
            runnerPath,
            "import { load } from '../checker/config'; export const run = load;",
          ],
          [checkerConfigPath, checkerConfigSource],
        ]),
        manifest,
      );
      return findRuntimeImportCycles(files, neighbors);
    };

    for (const cyclicSource of [
      "import { run } from '#config/runner'; export const load = run;",
      "import { run } from 'limina/internal/config/runner'; export const load = run;",
      "import { run } from '../config/runner.js'; export const load = run;",
      "import {} from '#config/runner'; export const load = 1;",
      "import { type Foo } from '#config/runner'; export const load = 1;",
      "export {} from '#config/runner'; export const load = 1;",
    ]) {
      expect(cyclesFor(cyclicSource), cyclicSource).toHaveLength(1);
    }

    for (const typeOnlySource of [
      "import type { Foo } from '#config/runner'; export const load: Foo | null = null;",
      "import type { Foo } from 'limina/internal/config/runner'; export const load: Foo | null = null;",
      "export type { Foo } from '#config/runner'; export const load = 1;",
    ]) {
      expect(cyclesFor(typeOnlySource), typeOnlySource).toEqual([]);
    }

    const selfGraph = buildRuntimeImportGraph(
      new Map([[selfPath, "import './self.js'; export const self = 1;"]]),
      manifest,
    );
    expect(
      findRuntimeImportCycles(selfGraph.files, selfGraph.neighbors),
    ).toEqual([['config/self.ts']]);
  });

  it('keeps generated artifact application at the preflight manager boundary', async () => {
    await expect(
      findProductionCallers('materializeGeneratedArtifactPlan'),
    ).resolves.toEqual(['preflight/materialization.ts']);
    await expect(
      findProductionCallers('ensurePreflightGraphMaterialized'),
    ).resolves.toEqual(['preflight/manager.ts']);
  });

  it('keeps generation advancement private to the execution scheduler', async () => {
    await expect(
      findProductionCallers('createPreflightGenerationController'),
    ).resolves.toEqual(['execution/executor.ts']);

    for (const barrel of ['index.ts', 'preflight/index.ts']) {
      const source = await readFile(path.join(sourceRoot, barrel), 'utf8');
      expect(source).not.toContain("'./generation'");
      expect(source).not.toContain("'./preflight/generation'");
    }
  });

  it('does not introduce a preflight to execution dependency', async () => {
    const preflightRoot = path.join(sourceRoot, 'preflight');
    const directoryEntries2 = await collectProductionSourceFiles(preflightRoot);
    for (const filePath of directoryEntries2) {
      const sourceFile = ts.createSourceFile(
        filePath,
        await readFile(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const executionImports = sourceFile.statements.filter(
        (statement) =>
          ((ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier)) ||
            (ts.isExportDeclaration(statement) &&
              statement.moduleSpecifier !== undefined &&
              ts.isStringLiteral(statement.moduleSpecifier))) &&
          /(?:^|\/)execution(?:\/|$)/u.test(statement.moduleSpecifier.text),
      );
      expect(executionImports, filePath).toHaveLength(0);
    }
  });

  it('keeps check-reporting, preflight, and execution free of upward subsystem runtime dependencies', async () => {
    const { files, neighbors } = await collectRuntimeImportGraph();
    expect(findUpwardLayerViolations(neighbors)).toEqual([]);
    expect(findUnexpectedTopLevelCycles(files, neighbors)).toEqual([]);
  });

  it('detects upward layer violations and directory cycles across relative paths and package self-exports', async () => {
    const manifest = await loadPackageManifest();
    const reportingProbePath = path.join(
      sourceRoot,
      'check-reporting/probe.ts',
    );
    const coreTargetPath = path.join(
      sourceRoot,
      'core/workspace/owner-identity.ts',
    );
    const checkerTargetPath = path.join(sourceRoot, 'checker/project-base.ts');
    const preflightEntryPath = path.join(sourceRoot, 'preflight/index.ts');
    const preflightConsumerPath = path.join(
      sourceRoot,
      'preflight/consumer.ts',
    );
    const reportingLeafPath = path.join(sourceRoot, 'check-reporting/leaf.ts');

    const analyzeUpward = (probeSource: string) =>
      findUpwardLayerViolations(
        buildRuntimeImportGraph(
          new Map([
            [reportingProbePath, probeSource],
            [coreTargetPath, 'export const owner = 1;'],
            [checkerTargetPath, 'export const checker = 1;'],
          ]),
          manifest,
        ).neighbors,
      );

    expect(
      analyzeUpward(
        "export { owner } from '../core/workspace/owner-identity';",
      ),
    ).toEqual(['check-reporting/probe.ts -> core/workspace/owner-identity.ts']);
    expect(
      analyzeUpward(
        "export { owner } from 'limina/internal/core/workspace/owner-identity';",
      ),
    ).toEqual(['check-reporting/probe.ts -> core/workspace/owner-identity.ts']);
    expect(
      analyzeUpward("export { checker } from '../checker/project-base';"),
    ).toEqual(['check-reporting/probe.ts -> checker/project-base.ts']);
    expect(
      analyzeUpward(
        "export { checker } from 'limina/internal/checker/project-base';",
      ),
    ).toEqual(['check-reporting/probe.ts -> checker/project-base.ts']);
    expect(
      analyzeUpward(
        "import type { Foo } from 'limina/internal/checker/project-base'; export const value: Foo | null = null;",
      ),
    ).toEqual([]);

    for (const reportingImport of [
      "import { entry } from '../preflight/index'; export const probe = entry;",
      "import { entry } from 'limina/internal/preflight'; export const probe = entry;",
    ]) {
      const { files, neighbors } = buildRuntimeImportGraph(
        new Map([
          [preflightEntryPath, 'export const entry = 1;'],
          [
            preflightConsumerPath,
            "import { leaf } from '../check-reporting/leaf'; export const used = leaf;",
          ],
          [reportingLeafPath, 'export const leaf = 1;'],
          [reportingProbePath, reportingImport],
        ]),
        manifest,
      );
      expect(findRuntimeImportCycles(files, neighbors)).toEqual([]);
      expect(findUnexpectedTopLevelCycles(files, neighbors)).toEqual([
        ['check-reporting', 'preflight'],
      ]);
    }
  });

  it('prevents governance modules from directly importing Core low-level producers or cache stores', async () => {
    const { neighbors } = await collectRuntimeImportGraph();
    const governanceRoots = [
      'graph-check/',
      'source-check/',
      'proof/',
      'dependency-graph/',
      'package-check/',
    ];
    const forbiddenTargets = new Set([
      'core/project-dependencies/runtime-source.ts',
      'core/project-dependencies/runtime-source-resolution.ts',
      'core/typescript-semantic/native-program-host.ts',
      'preflight/analysis-cache-store.ts',
    ]);
    const violations: string[] = [];
    for (const [filePath, targets] of neighbors) {
      const relative = toPortablePath(path.relative(sourceRoot, filePath));
      if (governanceRoots.every((prefix) => !relative.startsWith(prefix))) {
        continue;
      }
      for (const target of targets) {
        const relativeTarget = toPortablePath(
          path.relative(sourceRoot, target),
        );
        if (forbiddenTargets.has(relativeTarget)) {
          violations.push(`${relative} -> ${relativeTarget}`);
        }
      }
    }
    expect(violations).toEqual([]);
    await expect(
      findProductionCallers('collectRuntimeProjectDependencies'),
    ).resolves.toEqual(['core/facts/session.ts']);
  });

  it('keeps Core Stage A/B1 facts modules independent of Stage B2 graph preparation', async () => {
    const { neighbors } = await collectRuntimeImportGraph();
    expect(findFactsImportsOfStageB2(neighbors)).toEqual([]);
  });

  it('reports the facts-to-B2 path through a B1 helper and cyclic re-export chain', async () => {
    const manifest = await loadPackageManifest();
    const stageB2Specifier =
      'limina/internal/core/build-graph/reference-inference';
    const analyze = (reExport: string) => {
      const { neighbors } = buildRuntimeImportGraph(
        new Map([
          [
            path.join(sourceRoot, 'core/facts/probe.ts'),
            "import { lookup } from '../build-graph/file-owner-lookup.js'; export const probe = lookup;",
          ],
          [
            path.join(sourceRoot, 'core/build-graph/file-owner-lookup.ts'),
            "export { lookup } from '../../utils/facts-bridge';",
          ],
          [
            path.join(sourceRoot, 'utils/facts-bridge.ts'),
            `import '../core/build-graph/file-owner-lookup'; export const lookup = 1; ${reExport}`,
          ],
          [
            path.join(sourceRoot, 'core/build-graph/reference-inference.ts'),
            'export type Result = number; export const result = 1;',
          ],
        ]),
        manifest,
      );
      return findFactsImportsOfStageB2(neighbors);
    };

    expect(
      analyze(`export type { Result } from '${stageB2Specifier}';`),
    ).toEqual([]);
    expect(analyze(`export { result } from '${stageB2Specifier}';`)).toEqual([
      'core/facts/probe.ts -> core/build-graph/file-owner-lookup.ts -> utils/facts-bridge.ts -> core/build-graph/reference-inference.ts',
    ]);
  });

  it('keeps Core modules free of direct runtime dependencies on core/index.ts', async () => {
    const { neighbors } = await collectRuntimeImportGraph();
    expect(findCoreBarrelImporters(neighbors)).toEqual([]);
  });

  it('detects a Core barrel re-export from a loose Core file and allows external or type-only imports', async () => {
    const { neighbors } = buildRuntimeImportGraph(
      new Map([
        [
          path.join(sourceRoot, 'core/index.ts'),
          'export type Value = number; export const value = 1;',
        ],
        [
          path.join(sourceRoot, 'core/probe.ts'),
          "export { value } from '#core';",
        ],
        [
          path.join(sourceRoot, 'core/facts/typed.ts'),
          "import type { Value } from '../index.js'; export type Typed = Value;",
        ],
        [
          path.join(sourceRoot, 'preflight/probe.ts'),
          "import { value } from '#core'; export const probe = value;",
        ],
      ]),
      await loadPackageManifest(),
    );
    expect(findCoreBarrelImporters(neighbors)).toEqual(['core/probe.ts']);
  });
});

import { createElapsedTimer } from 'logaria/helper';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import type { ResolvedLiminaConfig } from '../config';
import type { LiminaFlowReporter } from '../flow';
import { PathsLogger, clearCliScreen, formatErrorMessage } from '../logger';
import {
  aliasMatchesSpecifier,
  collectExportEntries,
} from '../package-exports';
import {
  collectGraphProjectRoute,
  getRawReferencePaths,
  readJsonConfig,
} from '../tsconfig';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '../utils/path';
import {
  collectImporters,
  collectWorkspacePackages,
  findPackageForSpecifier,
  type ImporterInfo,
  type WorkspacePackage,
} from '../workspace';

interface ProjectInfo {
  configPath: string;
  fileNames: string[];
  options: ts.CompilerOptions;
  references: Set<string>;
}

interface ImportRecord {
  filePath: string;
  line: number;
  specifier: string;
}

interface GeneratedConfig {
  aliasCount: number;
  configPaths: string[];
  content: string;
  outputPath: string;
}

interface PathsResult {
  aliasCount: number;
  changed: boolean;
  outputCount: number;
  suggestionCount: number;
}

export interface RunPathsOptions {
  check?: boolean;
  clearScreen?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

function generatedFileName(config: ResolvedLiminaConfig): string {
  return config.paths?.generatedFileName ?? 'tsconfig.dts.paths.generated.json';
}

function generatedFileMarker(config: ResolvedLiminaConfig): string {
  return (
    config.paths?.generatedFileMarker ?? 'GENERATED FILE - DO NOT EDIT BY HAND.'
  );
}

function parseProject(
  config: ResolvedLiminaConfig,
  configPath: string,
): ProjectInfo {
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
  );

  if (!parsed) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => config.rootDir,
        getNewLine: () => '\n',
      }),
    );
  }

  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => config.rootDir,
        getNewLine: () => '\n',
      }),
    );
  }

  return {
    configPath: normalizeAbsolutePath(configPath),
    fileNames: parsed.fileNames
      .filter((fileName) => /\.(?:[cm]?tsx?|d\.[cm]?ts)$/u.test(fileName))
      .map(normalizeAbsolutePath),
    options: parsed.options,
    references: new Set(getRawReferencePaths(config, configPath)),
  };
}

function getSourceFileKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }

  return ts.ScriptKind.TS;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function collectImportsFromFile(filePath: string): ImportRecord[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getSourceFileKind(filePath),
  );
  const imports: ImportRecord[] = [];
  const addImport = (specifier: string, node: ts.Node): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    imports.push({
      filePath,
      line: location.line + 1,
      specifier,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);

      if (specifier) {
        addImport(specifier, node);
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument)
        ? stringLiteralValue(node.argument.literal)
        : null;

      if (specifier) {
        addImport(specifier, node);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralValue(node.arguments[0]);

      if (specifier) {
        addImport(specifier, node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return imports;
}

function resolveInternalImport(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
  ).resolvedModule;

  return resolved?.resolvedFileName
    ? normalizeAbsolutePath(resolved.resolvedFileName)
    : null;
}

function resolveImportWithoutMatchingPaths(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | null {
  if (!options.paths) {
    return resolveInternalImport(specifier, containingFile, options);
  }

  const paths = Object.fromEntries(
    Object.entries(options.paths).filter(
      ([alias]) => !aliasMatchesSpecifier(alias, specifier),
    ),
  );
  const nextOptions: ts.CompilerOptions = {
    ...options,
    paths: Object.keys(paths).length > 0 ? paths : undefined,
  };

  return resolveInternalImport(specifier, containingFile, nextOptions);
}

function createFileOwnerLookup(projects: ProjectInfo[]): Map<string, string[]> {
  const ownerLookup = new Map<string, string[]>();

  for (const project of projects) {
    for (const fileName of project.fileNames) {
      const owners = ownerLookup.get(fileName) ?? [];

      owners.push(project.configPath);
      ownerLookup.set(fileName, owners);
    }
  }

  return ownerLookup;
}

function projectExtendsGeneratedConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
): boolean {
  const configObject = readJsonConfig(config, configPath);
  const extendsValue = configObject.extends;
  const extendsEntries =
    typeof extendsValue === 'string'
      ? [extendsValue]
      : Array.isArray(extendsValue)
        ? extendsValue
        : [];

  return extendsEntries.some(
    (entry) =>
      typeof entry === 'string' &&
      path.basename(entry) === generatedFileName(config),
  );
}

function findImporterForFile(
  filePath: string,
  importers: ImporterInfo[],
): ImporterInfo | null {
  return (
    importers.find((importer) =>
      isPathInsideDirectory(filePath, importer.directory),
    ) ?? null
  );
}

function shouldResolveThroughGraph(
  importer: ImporterInfo | null,
  targetPackage: WorkspacePackage | null,
): boolean {
  if (!importer || !targetPackage) {
    return false;
  }

  return (
    importer.name === targetPackage.name ||
    importer.workspaceDependencies.has(targetPackage.name)
  );
}

function inferPackageProject(
  resolvedFilePath: string,
  workspacePackage: WorkspacePackage,
  projectPaths: string[],
): string | null {
  if (!isPathInsideDirectory(resolvedFilePath, workspacePackage.directory)) {
    return null;
  }

  return (
    projectPaths.find((projectPath) => {
      return (
        projectPath.startsWith(`${workspacePackage.directory}/`) &&
        projectPath.endsWith('/tsconfig.lib.dts.json')
      );
    }) ?? null
  );
}

function addPathEntry(
  paths: Map<string, string[]>,
  alias: string,
  target: string,
): void {
  const targets = paths.get(alias) ?? [];

  if (!targets.includes(target)) {
    targets.push(target);
  }

  paths.set(alias, targets);
}

function compareAliases(left: string, right: string): number {
  const leftGroup = left.startsWith('@') ? 1 : 0;
  const rightGroup = right.startsWith('@') ? 1 : 0;

  if (leftGroup !== rightGroup) {
    return leftGroup - rightGroup;
  }

  const leftRoot = left.startsWith('@')
    ? left.split('/').slice(0, 2).join('/')
    : (left.split('/')[0] ?? left);
  const rightRoot = right.startsWith('@')
    ? right.split('/').slice(0, 2).join('/')
    : (right.split('/')[0] ?? right);

  if (leftRoot === rightRoot) {
    const leftPrefixLength = left.split('*')[0]?.length ?? left.length;
    const rightPrefixLength = right.split('*')[0]?.length ?? right.length;

    if (leftPrefixLength !== rightPrefixLength) {
      return rightPrefixLength - leftPrefixLength;
    }
  }

  return left.localeCompare(right);
}

function toTsconfigPathTarget(
  config: ResolvedLiminaConfig,
  outputDirectory: string,
  target: string,
): string {
  const relativeTarget = toPosixPath(
    path.relative(outputDirectory, toAbsolutePath(config.rootDir, target)),
  );

  if (relativeTarget.startsWith('./') || relativeTarget.startsWith('../')) {
    return relativeTarget;
  }

  return `./${relativeTarget}`;
}

function formatPaths(
  config: ResolvedLiminaConfig,
  paths: Map<string, string[]>,
  outputDirectory: string,
): string {
  const lines: string[] = [];
  const entries = [...paths.entries()].sort(([left], [right]) =>
    compareAliases(left, right),
  );

  for (const [alias, targets] of entries) {
    const pathTargets = targets.map((target) =>
      toTsconfigPathTarget(config, outputDirectory, target),
    );

    if (
      pathTargets.length === 1 &&
      `${JSON.stringify(alias)}: [${JSON.stringify(pathTargets[0])}],`.length <
        80
    ) {
      lines.push(
        `      ${JSON.stringify(alias)}: [${JSON.stringify(pathTargets[0])}],`,
      );
      continue;
    }

    lines.push(`      ${JSON.stringify(alias)}: [`);

    for (const target of pathTargets) {
      lines.push(`        ${JSON.stringify(target)},`);
    }

    lines.push('      ],');
  }

  return lines.join('\n');
}

function formatGeneratedConfig(
  config: ResolvedLiminaConfig,
  paths: Map<string, string[]>,
  outputPath: string,
): string {
  const outputDirectory = path.dirname(outputPath);

  return `{
  "$schema": "https://json.schemastore.org/tsconfig",
  /**
   * ${generatedFileMarker(config)}
   *
   * Compatibility paths for workspace:* source dependencies whose package
   * exports resolve to build artifacts. Run \`limina paths generate\` to
   * refresh this file, then manually extend it from the relevant
   * tsconfig*.dts.json files.
   */
  "compilerOptions": {
    "paths": {
${formatPaths(config, paths, outputDirectory)}
    }
  }
}
`;
}

interface GeneratedConfigDraft {
  configPaths: Set<string>;
  paths: Map<string, string[]>;
}

function getDraft(
  drafts: Map<string, GeneratedConfigDraft>,
  outputPath: string,
): GeneratedConfigDraft {
  const existing = drafts.get(outputPath);

  if (existing) {
    return existing;
  }

  const created = {
    configPaths: new Set<string>(),
    paths: new Map<string, string[]>(),
  };

  drafts.set(outputPath, created);
  return created;
}

function createGeneratedConfigs(
  config: ResolvedLiminaConfig,
  drafts: Map<string, GeneratedConfigDraft>,
): GeneratedConfig[] {
  return [...drafts.entries()]
    .map(([outputPath, draft]) => ({
      aliasCount: draft.paths.size,
      configPaths: [...draft.configPaths].sort((left, right) =>
        left.localeCompare(right),
      ),
      content: formatGeneratedConfig(config, draft.paths, outputPath),
      outputPath,
    }))
    .filter((generatedConfig) => generatedConfig.aliasCount > 0)
    .sort((left, right) => left.outputPath.localeCompare(right.outputPath));
}

async function collectGeneratedConfigs(
  config: ResolvedLiminaConfig,
): Promise<GeneratedConfig[]> {
  const graphRoute = collectGraphProjectRoute(config);
  const projectPaths = graphRoute.projectPaths;

  if (graphRoute.problems.length > 0) {
    throw new Error(graphRoute.problems.join('\n\n'));
  }

  const projects = projectPaths.map((projectPath) =>
    parseProject(config, projectPath),
  );
  const fileOwnerLookup = createFileOwnerLookup(projects);
  const packages = await collectWorkspacePackages(config);
  const importers = collectImporters(config, packages);
  const exportEntriesByPackage = new Map<string, [string, string][]>();
  const drafts = new Map<string, GeneratedConfigDraft>();

  for (const project of projects) {
    const keepsGeneratedPaths = projectExtendsGeneratedConfig(
      config,
      project.configPath,
    );

    for (const filePath of project.fileNames) {
      for (const importRecord of collectImportsFromFile(filePath)) {
        const targetPackage = findPackageForSpecifier(
          importRecord.specifier,
          packages,
        );
        const importer = targetPackage
          ? findImporterForFile(importRecord.filePath, importers)
          : null;

        if (
          !targetPackage ||
          !shouldResolveThroughGraph(importer, targetPackage)
        ) {
          continue;
        }

        const resolvedFilePath = resolveInternalImport(
          importRecord.specifier,
          filePath,
          project.options,
        );

        if (!resolvedFilePath) {
          continue;
        }

        const resolvedThroughGraph = fileOwnerLookup.has(resolvedFilePath);

        const artifactResolvedFilePath =
          resolvedThroughGraph && keepsGeneratedPaths
            ? resolveImportWithoutMatchingPaths(
                importRecord.specifier,
                filePath,
                project.options,
              )
            : resolvedFilePath;

        if (
          !artifactResolvedFilePath ||
          fileOwnerLookup.has(artifactResolvedFilePath)
        ) {
          continue;
        }

        const targetProjectPath = inferPackageProject(
          artifactResolvedFilePath,
          targetPackage,
          projectPaths,
        );

        if (!targetProjectPath || !project.references.has(targetProjectPath)) {
          continue;
        }

        const exportEntries =
          exportEntriesByPackage.get(targetPackage.name) ??
          collectExportEntries(config, targetPackage);

        exportEntriesByPackage.set(targetPackage.name, exportEntries);

        if (
          !exportEntries.some(([alias]) =>
            aliasMatchesSpecifier(alias, importRecord.specifier),
          )
        ) {
          continue;
        }

        const outputPath = path.join(
          path.dirname(project.configPath),
          generatedFileName(config),
        );
        const draft = getDraft(drafts, outputPath);

        draft.configPaths.add(project.configPath);

        for (const [alias, target] of exportEntries) {
          addPathEntry(draft.paths, alias, target);
        }
      }
    }
  }

  return createGeneratedConfigs(config, drafts);
}

async function isGeneratedTsconfigPathsFile(
  config: ResolvedLiminaConfig,
  filePath: string,
): Promise<boolean> {
  try {
    return (await readFile(filePath, 'utf8')).includes(
      generatedFileMarker(config),
    );
  } catch {
    return false;
  }
}

async function collectExistingGeneratedConfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  const files = await glob(`**/${generatedFileName(config)}`, {
    cwd: config.rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  });

  return files.map((filePath) => path.resolve(filePath)).sort();
}

async function writeGeneratedConfigs(
  config: ResolvedLiminaConfig,
  generatedConfigs: GeneratedConfig[],
): Promise<boolean> {
  let didChange = false;
  const expectedOutputPaths = new Set(
    generatedConfigs.map((generatedConfig) =>
      path.resolve(generatedConfig.outputPath),
    ),
  );

  for (const existingFile of await collectExistingGeneratedConfigPaths(
    config,
  )) {
    if (expectedOutputPaths.has(existingFile)) {
      continue;
    }

    if (await isGeneratedTsconfigPathsFile(config, existingFile)) {
      await rm(existingFile);
      didChange = true;
    }
  }

  for (const generatedConfig of generatedConfigs) {
    const currentContent = existsSync(generatedConfig.outputPath)
      ? await readFile(generatedConfig.outputPath, 'utf8')
      : null;

    if (currentContent === generatedConfig.content) {
      continue;
    }

    await mkdir(path.dirname(generatedConfig.outputPath), { recursive: true });
    await writeFile(generatedConfig.outputPath, generatedConfig.content);
    didChange = true;
  }

  return didChange;
}

async function checkGeneratedConfigs(
  config: ResolvedLiminaConfig,
  generatedConfigs: GeneratedConfig[],
): Promise<boolean> {
  const expectedOutputPaths = new Set(
    generatedConfigs.map((generatedConfig) =>
      path.resolve(generatedConfig.outputPath),
    ),
  );

  for (const existingFile of await collectExistingGeneratedConfigPaths(
    config,
  )) {
    if (expectedOutputPaths.has(existingFile)) {
      continue;
    }

    if (await isGeneratedTsconfigPathsFile(config, existingFile)) {
      return true;
    }
  }

  for (const generatedConfig of generatedConfigs) {
    const currentContent = existsSync(generatedConfig.outputPath)
      ? await readFile(generatedConfig.outputPath, 'utf8')
      : null;

    if (currentContent !== generatedConfig.content) {
      return true;
    }
  }

  return false;
}

function toTsconfigExtendsPath(configPath: string, targetPath: string): string {
  const relativeTarget = toPosixPath(
    path.relative(path.dirname(configPath), targetPath),
  );

  if (relativeTarget.startsWith('./') || relativeTarget.startsWith('../')) {
    return relativeTarget;
  }

  return `./${relativeTarget}`;
}

function logManualExtendsSuggestions(
  config: ResolvedLiminaConfig,
  generatedConfigs: GeneratedConfig[],
): void {
  const suggestionCount = generatedConfigs.reduce(
    (total, generatedConfig) => total + generatedConfig.configPaths.length,
    0,
  );

  if (suggestionCount === 0) {
    PathsLogger.info(
      'No workspace:* artifact-export compatibility paths are needed.',
    );
    return;
  }

  PathsLogger.info(
    'Generated path configs are not injected automatically. Add them manually to the first position of each listed extends array:',
  );

  for (const generatedConfig of generatedConfigs) {
    PathsLogger.info(
      `  ${toRelativePath(config.rootDir, generatedConfig.outputPath)} (${generatedConfig.aliasCount} aliases)`,
    );

    for (const configPath of generatedConfig.configPaths) {
      PathsLogger.info(
        `    - ${toRelativePath(config.rootDir, configPath)} extends ${toTsconfigExtendsPath(configPath, generatedConfig.outputPath)}`,
      );
    }
  }
}

async function runPathsInternal(
  config: ResolvedLiminaConfig,
  options: { check?: boolean } = {},
): Promise<PathsResult> {
  const generatedConfigs = await collectGeneratedConfigs(config);
  const didChange = options.check
    ? await checkGeneratedConfigs(config, generatedConfigs)
    : await writeGeneratedConfigs(config, generatedConfigs);
  const aliasCount = generatedConfigs.reduce(
    (total, generatedConfig) => total + generatedConfig.aliasCount,
    0,
  );
  const suggestionCount = generatedConfigs.reduce(
    (total, generatedConfig) => total + generatedConfig.configPaths.length,
    0,
  );
  const action = options.check
    ? didChange
      ? 'Would update'
      : 'Checked unchanged'
    : didChange
      ? 'Generated'
      : 'Skipped unchanged';

  PathsLogger.info(
    `${action} ${generatedConfigs.length} TypeScript graph path config files with ${aliasCount} path aliases.`,
  );
  logManualExtendsSuggestions(config, generatedConfigs);

  if (options.check && didChange) {
    PathsLogger.error(
      'TypeScript graph path state is stale; run `limina paths generate`, then manually extend the listed tsconfig*.dts.json files.',
    );
  }

  return {
    aliasCount,
    changed: didChange,
    outputCount: generatedConfigs.length,
    suggestionCount,
  };
}

export async function runPaths(
  config: ResolvedLiminaConfig,
  options: RunPathsOptions = {},
): Promise<PathsResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const action = options.check ? 'paths check' : 'paths generate';
  const task = options.flow?.start(action, {
    depth: options.flowDepth ?? 0,
  });

  PathsLogger.info(`${action} started`);

  try {
    const result = await runPathsInternal(config, options);

    if (options.check && result.changed) {
      PathsLogger.error(`${action} finished with stale files`, elapsed());
      task?.fail(`${action} finished with stale files`);
    } else {
      if (!options.flow?.interactive) {
        PathsLogger.success(`${action} finished`, elapsed());
      }

      task?.pass();
    }

    return result;
  } catch (error) {
    PathsLogger.error(
      `${action} failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail(`${action} failed`, { error });
    throw error;
  }
}

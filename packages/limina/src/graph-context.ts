import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
  resolveModuleNameWithCheckers,
} from './checkers';
import type { ResolvedLiminaConfig } from './config';
import {
  createExtensionPattern,
  getDtsCompanionConfigPath,
  getRawReferencePaths,
  isDtsConfigPath,
  readJsonConfig,
} from './tsconfig';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from './utils/path';
import {
  findPackageForSpecifier,
  type ImporterInfo,
  type WorkspacePackage,
} from './workspace';

export interface ProjectInfo {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  fileNames: string[];
  labels: string[];
  labelProblem: string | null;
  options: ts.CompilerOptions;
  references: Set<string>;
}

export interface ImportRecord {
  filePath: string;
  line: number;
  specifier: string;
}

interface VueSfcBlock {
  content: string;
  lang?: string;
  loc: {
    start: {
      line: number;
    };
  };
  src?: string;
}

interface VueCompilerSfc {
  parse: (
    source: string,
    options?: { filename?: string },
  ) => {
    descriptor: {
      script?: VueSfcBlock | null;
      scriptSetup?: VueSfcBlock | null;
    };
    errors: unknown[];
  };
}

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

export function isDtsProjectConfig(configPath: string): boolean {
  return isDtsConfigPath(configPath);
}

export function getTypecheckConfigPath(dtsConfigPath: string): string {
  return getDtsCompanionConfigPath(dtsConfigPath);
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function readProjectGraphRules(
  config: ResolvedLiminaConfig,
  configPath: string,
): Pick<ProjectInfo, 'labels' | 'labelProblem'> {
  if (!isDtsProjectConfig(configPath)) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  const configObject = readJsonConfig(config, configPath);

  if (!Object.hasOwn(configObject, 'liminaOptions')) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  const optionsValue = configObject.liminaOptions;

  if (
    !optionsValue ||
    typeof optionsValue !== 'object' ||
    Array.isArray(optionsValue)
  ) {
    return {
      labels: [],
      labelProblem: [
        'Invalid Limina graph options:',
        `  project: ${toRelativePath(config.rootDir, configPath)}`,
        '  field: liminaOptions',
        `  value: ${formatUnknownValue(optionsValue)}`,
        '  reason: liminaOptions must be an object with an optional graphRules array.',
      ].join('\n'),
    };
  }

  const graphRules = (optionsValue as { graphRules?: unknown }).graphRules;

  if (graphRules === undefined) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  if (!Array.isArray(graphRules)) {
    return {
      labels: [],
      labelProblem: [
        'Invalid Limina graph rules:',
        `  project: ${toRelativePath(config.rootDir, configPath)}`,
        '  field: liminaOptions.graphRules',
        `  value: ${formatUnknownValue(graphRules)}`,
        '  reason: liminaOptions.graphRules must be an array of non-empty string labels.',
      ].join('\n'),
    };
  }

  const labels: string[] = [];

  for (const [index, value] of graphRules.entries()) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return {
        labels: [],
        labelProblem: [
          'Invalid Limina graph rule label:',
          `  project: ${toRelativePath(config.rootDir, configPath)}`,
          `  field: liminaOptions.graphRules[${index}]`,
          `  value: ${formatUnknownValue(value)}`,
          '  reason: graph rule labels must be non-empty strings.',
        ].join('\n'),
      };
    }

    const label = value.trim();

    if (!labels.includes(label)) {
      labels.push(label);
    }
  }

  return {
    labels,
    labelProblem: null,
  };
}

export function formatProjectLabels(labels: readonly string[]): string {
  if (labels.length === 0) {
    return '(none)';
  }

  return labels.join(', ');
}

export function parseProject(
  config: ResolvedLiminaConfig,
  configPath: string,
  contextOrExtensions?: CheckerProjectParseContext | string[],
): ProjectInfo {
  const context = Array.isArray(contextOrExtensions)
    ? {
        checkerPresets: [] as CheckerProjectParseContext['checkerPresets'],
        extensions: contextOrExtensions,
      }
    : (contextOrExtensions ?? {
        checkerPresets: [] as CheckerProjectParseContext['checkerPresets'],
        extensions: [],
      });
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
  });
  const labelInfo = readProjectGraphRules(config, configPath);
  const projectExtensions = parsed.extensions;
  const filePattern = createExtensionPattern(projectExtensions);

  return {
    checkerPresets: context.checkerPresets,
    configPath: normalizeAbsolutePath(configPath),
    extensions: projectExtensions,
    fileNames: parsed.fileNames
      .filter((fileName) => filePattern.test(fileName))
      .map(normalizeAbsolutePath),
    labels: labelInfo.labels,
    labelProblem: labelInfo.labelProblem,
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

  if (
    filePath.endsWith('.js') ||
    filePath.endsWith('.mjs') ||
    filePath.endsWith('.cjs')
  ) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function getVueCompilerSfc(rootDir: string): VueCompilerSfc {
  const requireFromRoot = createRequire(path.join(rootDir, 'package.json'));

  try {
    return requireFromRoot('@vue/compiler-sfc') as VueCompilerSfc;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      throw new Error(
        'Vue source graph support requires @vue/compiler-sfc. Fix: pnpm add -D @vue/compiler-sfc',
      );
    }

    throw error;
  }
}

function getVueBlockScriptKind(block: VueSfcBlock): ts.ScriptKind {
  return block.lang === 'tsx' || block.lang === 'jsx'
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function collectImportsFromSourceText(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceText: string;
}): ImportRecord[] {
  const sourceFile = ts.createSourceFile(
    options.filePath,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  const imports: ImportRecord[] = [];
  const lineOffset = options.lineOffset ?? 0;
  const addImport = (specifier: string, node: ts.Node): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    imports.push({
      filePath: options.filePath,
      line: lineOffset + location.line + 1,
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

function collectVueImportsFromFile(
  filePath: string,
  rootDir: string,
): ImportRecord[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const compiler = getVueCompilerSfc(rootDir);
  const result = compiler.parse(sourceText, { filename: filePath });

  if (result.errors.length > 0) {
    throw new Error(
      `Failed to parse Vue SFC imports for ${toRelativePath(rootDir, filePath)}: ${String(result.errors[0])}`,
    );
  }

  return [result.descriptor.script, result.descriptor.scriptSetup]
    .filter((block): block is VueSfcBlock => Boolean(block && !block.src))
    .flatMap((block) =>
      collectImportsFromSourceText({
        filePath,
        lineOffset: block.loc.start.line - 1,
        scriptKind: getVueBlockScriptKind(block),
        sourceText: block.content,
      }),
    );
}

export function collectImportsFromFile(
  filePath: string,
  rootDir: string,
): ImportRecord[] {
  if (filePath.endsWith('.vue')) {
    return collectVueImportsFromFile(filePath, rootDir);
  }

  return collectImportsFromSourceText({
    filePath,
    scriptKind: getSourceFileKind(filePath),
    sourceText: readFileSync(filePath, 'utf8'),
  });
}

export function resolveInternalImport(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  contextOrExtensions: CheckerProjectParseContext | ProjectInfo | string[] = [],
): string | null {
  const context = Array.isArray(contextOrExtensions)
    ? {
        checkerPresets: [] as CheckerProjectParseContext['checkerPresets'],
        extensions: contextOrExtensions,
      }
    : {
        checkerPresets: contextOrExtensions.checkerPresets,
        extensions: contextOrExtensions.extensions,
      };
  const resolved = resolveModuleNameWithCheckers({
    compilerOptions: options,
    containingFile,
    context,
    specifier,
  });

  return resolved ? normalizeAbsolutePath(resolved) : null;
}

function chooseOwningProject(projectPaths: string[]): string {
  return [...projectPaths].sort((left, right) => {
    const directoryDepthDelta =
      path.dirname(right).length - path.dirname(left).length;

    return directoryDepthDelta === 0
      ? left.localeCompare(right)
      : directoryDepthDelta;
  })[0]!;
}

export function findPackageForFile(
  filePath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    [...packages]
      .sort((left, right) => right.directory.length - left.directory.length)
      .find((workspacePackage) =>
        isPathInsideDirectory(filePath, workspacePackage.directory),
      ) ?? null
  );
}

export function isWorkspacePackageFile(
  filePath: string,
  packages: WorkspacePackage[],
): boolean {
  return packages.some((workspacePackage) =>
    isPathInsideDirectory(filePath, workspacePackage.directory),
  );
}

export function findImporterForFile(
  filePath: string,
  importers: ImporterInfo[],
): ImporterInfo | null {
  return (
    importers.find((importer) =>
      isPathInsideDirectory(filePath, importer.directory),
    ) ?? null
  );
}

export function shouldResolveThroughGraph(
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

export function formatArtifactDependencyPolicy(
  targetPackage: WorkspacePackage,
): string {
  return targetPackage.manifest.private === true
    ? 'private workspace packages cannot be consumed from a registry, so artifact consumers should use link: and should not keep a project reference.'
    : 'artifact consumers should use link: for local dist output, or catalog:/semver to consume the published production package, and should not keep a project reference.';
}

export function inferPackageProject(
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

export function createFileOwnerLookup(
  projects: ProjectInfo[],
): Map<string, string[]> {
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

export function findTargetProject(options: {
  fileOwnerLookup: Map<string, string[]>;
  packages: WorkspacePackage[];
  projectPaths: string[];
  resolvedFilePath: string;
  specifier: string;
}): string | null {
  const ownerProjects = options.fileOwnerLookup.get(options.resolvedFilePath);

  if (ownerProjects && ownerProjects.length > 0) {
    return chooseOwningProject(ownerProjects);
  }

  const workspacePackage = findPackageForSpecifier(
    options.specifier,
    options.packages,
  );

  if (!workspacePackage) {
    return null;
  }

  return inferPackageProject(
    options.resolvedFilePath,
    workspacePackage,
    options.projectPaths,
  );
}

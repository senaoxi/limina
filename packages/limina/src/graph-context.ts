import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type { ResolvedLiminaConfig } from './config';
import {
  createExtensionPattern,
  createExtraFileExtensions,
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
  configPath: string;
  extensions: string[];
  fileNames: string[];
  label: string | null;
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

function readProjectLabel(
  config: ResolvedLiminaConfig,
  configPath: string,
): Pick<ProjectInfo, 'label' | 'labelProblem'> {
  if (!isDtsProjectConfig(configPath)) {
    return {
      label: null,
      labelProblem: null,
    };
  }

  const configObject = readJsonConfig(config, configPath);

  if (!Object.hasOwn(configObject, 'limina')) {
    return {
      label: null,
      labelProblem: null,
    };
  }

  const value = configObject.limina;

  if (typeof value === 'string' && value.trim()) {
    return {
      label: value.trim(),
      labelProblem: null,
    };
  }

  return {
    label: null,
    labelProblem: [
      'Invalid Limina graph label:',
      `  project: ${toRelativePath(config.rootDir, configPath)}`,
      `  field: limina`,
      `  value: ${formatUnknownValue(value)}`,
      '  reason: tsconfig*.dts.json may declare one non-empty string label with "limina".',
    ].join('\n'),
  };
}

export function parseProject(
  config: ResolvedLiminaConfig,
  configPath: string,
  extensions?: string[],
): ProjectInfo {
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = extensions
    ? ts.parseJsonConfigFileContent(
        readJsonConfig(config, configPath),
        ts.sys,
        path.dirname(configPath),
        {},
        configPath,
        undefined,
        createExtraFileExtensions(extensions),
      )
    : ts.getParsedCommandLineOfConfigFile(
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

  const labelInfo = readProjectLabel(config, configPath);
  const projectExtensions = extensions ?? [
    '.ts',
    '.tsx',
    '.cts',
    '.mts',
    '.d.ts',
    '.d.cts',
    '.d.mts',
  ];
  const filePattern = createExtensionPattern(projectExtensions);

  return {
    configPath: normalizeAbsolutePath(configPath),
    extensions: projectExtensions,
    fileNames: parsed.fileNames
      .filter((fileName) => filePattern.test(fileName))
      .map(normalizeAbsolutePath),
    label: labelInfo.label,
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
  extensions: string[] = [],
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
  ).resolvedModule;

  if (resolved?.resolvedFileName) {
    return normalizeAbsolutePath(resolved.resolvedFileName);
  }

  if (!isRelativeSpecifier(specifier)) {
    return null;
  }

  const resolvedSpecifierPath = path.resolve(
    path.dirname(containingFile),
    specifier,
  );
  const candidatePaths = path.extname(specifier)
    ? [resolvedSpecifierPath]
    : extensions.flatMap((extension) => [
        `${resolvedSpecifierPath}${extension}`,
        path.join(resolvedSpecifierPath, `index${extension}`),
      ]);

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    if (!statSync(candidatePath).isFile()) {
      continue;
    }

    return normalizeAbsolutePath(candidatePath);
  }

  return null;
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

import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type ts from 'typescript';
import { createFormatHost } from './project-base';
import type {
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
} from './types';
import { parseVueProjectWithSemanticIdentity } from './vue-semantic-identity';

type VueSemanticParseResult = ReturnType<
  typeof parseVueProjectWithSemanticIdentity
>;

function isIgnoredNoInputDiagnostic(
  diagnostic: ts.Diagnostic,
  allowNoInputDiagnostics: boolean | undefined,
): boolean {
  return (
    allowNoInputDiagnostics === true &&
    (diagnostic.code === 18_002 || diagnostic.code === 18_003)
  );
}

function assertNoVueParseErrors(options: {
  allowNoInputDiagnostics?: boolean;
  projectRootDir: string;
  result: VueSemanticParseResult;
}): void {
  const diagnostics = options.result.diagnostics.filter(
    (diagnostic) =>
      !isIgnoredNoInputDiagnostic(diagnostic, options.allowNoInputDiagnostics),
  );
  if (diagnostics.length === 0) return;
  throw new Error(
    options.result.identity.toolchain.tsModule.formatDiagnosticsWithColorAndContext(
      diagnostics,
      createFormatHost(options.projectRootDir),
    ),
  );
}

function createSemanticParseResult(options: {
  packageName: string;
  parseOptions: CheckerProjectConfigParseOptions;
}): VueSemanticParseResult {
  try {
    return parseVueProjectWithSemanticIdentity(options.parseOptions);
  } catch (error) {
    throw new Error(
      [
        'Unable to initialize Vue project semantics:',
        `  checker package: ${options.packageName}`,
        `  config: ${toRelativePath(options.parseOptions.projectRootDir, options.parseOptions.configPath)}`,
        `  reason: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
      { cause: error },
    );
  }
}

function parseSemanticProject(options: {
  packageName: string;
  parseOptions: CheckerProjectConfigParseOptions;
}): VueSemanticParseResult {
  const result = createSemanticParseResult(options);
  assertNoVueParseErrors({
    allowNoInputDiagnostics: options.parseOptions.allowNoInputDiagnostics,
    projectRootDir: options.parseOptions.projectRootDir,
    result,
  });
  return result;
}

export function resolveVueProjectExtensions(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  return [
    ...parseSemanticProject({ packageName, parseOptions: options }).extensions,
  ];
}

export function resolveVueProjectExtensionsForChecker(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  return resolveVueProjectExtensions(options, packageName);
}

export function parseVueProjectConfig(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): ParsedCheckerProjectConfig {
  const result = parseSemanticProject({ packageName, parseOptions: options });
  return {
    configClosure: result.identity.configClosure.map((entry) => ({
      ...entry,
    })),
    extensions: [...result.extensions],
    fileNames: result.parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: { ...result.parsed.options },
    vueSemanticIdentity: result.identity,
  };
}

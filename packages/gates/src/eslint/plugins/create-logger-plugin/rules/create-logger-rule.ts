import type { Rule } from 'eslint';

const SHARED_UTILS_LOGGER_ENTRYPOINT = '@limina/build-tools/logger';
const PACKAGE_NAME_MAX_LENGTH = 214;
const PACKAGE_NAME_SEGMENT_RE = /^[\da-z][\d.a-z_~-]*$/u;
const RESERVED_PACKAGE_NAMES = new Set(['favicon.ico', 'node_modules']);
const USE_UTILS_LOGGER_MESSAGE =
  'Current package must import createLogger from @limina/build-tools/logger.';

type ImportDeclarationNode = Extract<Rule.Node, { type: 'ImportDeclaration' }>;
type ExportNamedDeclarationNode = Extract<
  Rule.Node,
  { type: 'ExportNamedDeclaration' }
>;
interface NamedSyntaxNode {
  name?: string;
  type: string;
  value?: unknown;
}

function getModuleSyntaxName(node: NamedSyntaxNode): string | undefined {
  if ('name' in node && typeof node.name === 'string') {
    return node.name;
  }

  return 'value' in node && typeof node.value === 'string'
    ? node.value
    : undefined;
}

function isValidPackageNameSegment(segment: string): boolean {
  return PACKAGE_NAME_SEGMENT_RE.test(segment);
}

function isValidPackageName(packageName: string): boolean {
  if (
    packageName.length === 0 ||
    packageName.length > PACKAGE_NAME_MAX_LENGTH ||
    packageName.trim() !== packageName ||
    packageName !== packageName.toLowerCase() ||
    RESERVED_PACKAGE_NAMES.has(packageName)
  ) {
    return false;
  }

  if (packageName.startsWith('@')) {
    const [scope, name, ...rest] = packageName.split('/');

    return (
      rest.length === 0 &&
      typeof scope === 'string' &&
      typeof name === 'string' &&
      isValidPackageNameSegment(scope.slice(1)) &&
      isValidPackageNameSegment(name)
    );
  }

  return !packageName.includes('/') && isValidPackageNameSegment(packageName);
}

function getPackageNameFromSource(sourceValue: string): string | undefined {
  if (
    sourceValue.startsWith('.') ||
    sourceValue.startsWith('/') ||
    sourceValue.startsWith('#') ||
    sourceValue.includes(':') ||
    sourceValue.includes('\\')
  ) {
    return undefined;
  }

  const sourceParts = sourceValue.split('/');

  if (sourceParts.some((part) => part.length === 0)) {
    return undefined;
  }

  if (sourceValue.startsWith('@')) {
    const [scope, name] = sourceParts;

    return typeof scope !== 'string' || typeof name !== 'string'
      ? undefined
      : `${scope}/${name}`;
  }

  return sourceParts[0];
}

function isRestrictedLoggerRuntimeSource(
  source: ImportDeclarationNode['source'],
): boolean {
  if (
    typeof source.value !== 'string' ||
    source.value === SHARED_UTILS_LOGGER_ENTRYPOINT
  ) {
    return false;
  }

  const packageName = getPackageNameFromSource(source.value);

  return typeof packageName === 'string' && isValidPackageName(packageName);
}

export const unifiedLogEntry: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require current package to import createLogger from the shared utils logger facade.',
      recommended: false,
    },
    schema: [],
    messages: {
      useUtilsLogger: USE_UTILS_LOGGER_MESSAGE,
    },
  },
  create(context) {
    function report(node: Rule.Node): void {
      context.report({
        messageId: 'useUtilsLogger',
        node,
      });
    }

    function checkImportDeclaration(node: ImportDeclarationNode): void {
      if (!isRestrictedLoggerRuntimeSource(node.source)) {
        return;
      }

      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          getModuleSyntaxName(specifier.imported) === 'createLogger'
        ) {
          report(node);
          return;
        }
      }
    }

    function checkExportNamedDeclaration(
      node: ExportNamedDeclarationNode,
    ): void {
      if (!node.source || !isRestrictedLoggerRuntimeSource(node.source)) {
        return;
      }

      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ExportSpecifier' &&
          getModuleSyntaxName(specifier.local) === 'createLogger'
        ) {
          report(node);
          return;
        }
      }
    }

    return {
      ExportNamedDeclaration: checkExportNamedDeclaration,
      ImportDeclaration: checkImportDeclaration,
    };
  },
};

import type { Rule } from 'eslint';

const canonicalPathCalls = new Set([
  'normalizeAbsolutePath',
  'path',
  'toPortablePath',
  'toPortablePaths',
  'toPortableRelativePath',
  'toPortableRelativePaths',
]);
const equalityOperators = new Set(['===', '!==', '==', '!=']);
const nativePathBuilders = new Set([
  'dirname',
  'format',
  'join',
  'normalize',
  'relative',
  'resolve',
]);
const pathMatchers = new Set([
  'toBe',
  'toContain',
  'toContainEqual',
  'toEqual',
  'toHaveBeenCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveNthReturnedWith',
  'toHaveProperty',
  'toHaveReturnedWith',
  'toMatchObject',
  'toStrictEqual',
]);

type BinaryExpressionNode = Extract<Rule.Node, { type: 'BinaryExpression' }>;
type CallExpressionNode = Extract<Rule.Node, { type: 'CallExpression' }>;
type CallArgument = CallExpressionNode['arguments'][number];
type ImportDeclarationNode = Extract<Rule.Node, { type: 'ImportDeclaration' }>;
type MemberExpressionNode = Extract<Rule.Node, { type: 'MemberExpression' }>;
type NodeWithParent = Rule.Node & { parent?: Rule.Node };
interface SyntaxNode {
  name?: string;
  object?: SyntaxNode;
  property?: SyntaxNode;
  type: string;
  value?: unknown;
}

function getSyntaxName(node: SyntaxNode): string | undefined {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  return undefined;
}

function getMemberPropertyName(node: SyntaxNode): string | undefined {
  return node.property ? getSyntaxName(node.property) : undefined;
}

function getCallName(node: CallExpressionNode): string | undefined {
  if (node.callee.type === 'Identifier') {
    return node.callee.name;
  }

  if (node.callee.type === 'MemberExpression') {
    return getMemberPropertyName(node.callee);
  }

  return undefined;
}

function getMemberRootName(node: SyntaxNode): string | undefined {
  let current = node.object;

  while (current?.type === 'MemberExpression') {
    current = current.object;
  }

  return current?.type === 'Identifier' ? current.name : undefined;
}

function isEqualityExpression(node: Rule.Node): node is BinaryExpressionNode {
  return (
    node.type === 'BinaryExpression' && equalityOperators.has(node.operator)
  );
}

function isCanonicalPathCall(node: Rule.Node): boolean {
  return (
    node.type === 'CallExpression' &&
    canonicalPathCalls.has(getCallName(node) ?? '')
  );
}

function isMatcherCall(node: Rule.Node): node is CallExpressionNode {
  return (
    node.type === 'CallExpression' && pathMatchers.has(getCallName(node) ?? '')
  );
}

function isExpectCall(node: Rule.Node): node is CallExpressionNode {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'expect'
  );
}

function isRawFixtureRootDir(node: MemberExpressionNode): boolean {
  return (
    node.object.type === 'Identifier' &&
    node.object.name === 'fixture' &&
    getMemberPropertyName(node) === 'rootDir'
  );
}

function isUnsafeComparison(node: Rule.Node): boolean {
  let child: Rule.Node = node;
  let current = (node as NodeWithParent).parent;
  let isDirectExpectValue = false;

  while (current) {
    if (isCanonicalPathCall(current)) {
      return false;
    }

    if (
      isEqualityExpression(current) &&
      (current.left === node || current.right === node)
    ) {
      return true;
    }

    if (
      isExpectCall(current) &&
      child === node &&
      current.arguments.includes(child as CallArgument)
    ) {
      isDirectExpectValue = true;
    }

    if (
      isMatcherCall(current) &&
      (isDirectExpectValue || current.arguments.includes(child as CallArgument))
    ) {
      return true;
    }

    child = current;
    current = (current as NodeWithParent).parent;
  }

  return false;
}

export const portablePathComparison: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require node:path results to be canonicalized before path comparisons in tests.',
      recommended: false,
    },
    schema: [],
    messages: {
      canonicalizePath:
        'Canonicalize node:path results with fixture.path(...), toPortablePath(...), or normalizeAbsolutePath(...) before comparison.',
    },
  },
  create(context) {
    const namedPathBuilders = new Set<string>();
    const pathNamespaces = new Set<string>();

    function collectPathImports(node: ImportDeclarationNode): void {
      if (node.source.value !== 'node:path') {
        return;
      }

      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ImportDefaultSpecifier' ||
          specifier.type === 'ImportNamespaceSpecifier'
        ) {
          pathNamespaces.add(specifier.local.name);
          continue;
        }

        if (
          specifier.type === 'ImportSpecifier' &&
          nativePathBuilders.has(getSyntaxName(specifier.imported) ?? '')
        ) {
          namedPathBuilders.add(specifier.local.name);
        }
      }
    }

    function isNativePathBuilderCall(node: CallExpressionNode): boolean {
      if (node.callee.type === 'Identifier') {
        return namedPathBuilders.has(node.callee.name);
      }

      if (node.callee.type !== 'MemberExpression') {
        return false;
      }

      if (
        node.callee.object.type === 'MemberExpression' &&
        getMemberPropertyName(node.callee.object) === 'posix'
      ) {
        return false;
      }

      return (
        nativePathBuilders.has(getMemberPropertyName(node.callee) ?? '') &&
        pathNamespaces.has(getMemberRootName(node.callee) ?? '')
      );
    }

    function checkCallExpression(node: CallExpressionNode): void {
      if (!isNativePathBuilderCall(node) || !isUnsafeComparison(node)) {
        return;
      }

      context.report({
        messageId: 'canonicalizePath',
        node,
      });
    }

    function checkMemberExpression(node: MemberExpressionNode): void {
      if (!isRawFixtureRootDir(node)) {
        return;
      }

      const parent = (node as NodeWithParent).parent;

      if (
        (parent?.type === 'CallExpression' &&
          isNativePathBuilderCall(parent)) ||
        !isUnsafeComparison(node)
      ) {
        return;
      }

      context.report({
        messageId: 'canonicalizePath',
        node,
      });
    }

    return {
      CallExpression: checkCallExpression,
      ImportDeclaration: collectPathImports,
      MemberExpression: checkMemberExpression,
    };
  },
};

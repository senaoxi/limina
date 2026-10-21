import type ts from 'typescript';

/**
 * Locate parsed nodes, including JSDoc omitted by forEachChild. This decorates
 * an existing occurrence; it never discovers compiler requests or resolves it.
 */
export function findSourceFileLiterals(options: {
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
  matches: (literal: ts.StringLiteralLike) => boolean;
}): ts.StringLiteralLike[] {
  const visited = new Set<ts.Node>();
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    collectLiteral(node, options, literals);
    options.tsModule.forEachChild(node, visit);
    for (const document of parsedJSDocumentNodes(node, options.tsModule))
      visit(document);
  };
  visit(options.sourceFile);
  return literals;
}

function parsedJSDocumentNodes(
  node: ts.Node,
  compiler: typeof ts,
): readonly ts.JSDoc[] {
  // TypeScript 5.4–6.0 stores all parsed comments here. The public
  // getJSDocCommentsAndTags filters earlier adjacent blocks by tag ownership,
  // even though the compiler's request inventory still includes their imports.
  const documents = (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc;
  return Array.isArray(documents) ? documents.filter(compiler.isJSDoc) : [];
}

function collectLiteral(
  node: ts.Node,
  options: Parameters<typeof findSourceFileLiterals>[0],
  literals: ts.StringLiteralLike[],
): void {
  if (options.tsModule.isStringLiteralLike(node) && options.matches(node))
    literals.push(node);
}

/**
 * A JSDoc node becomes evidence only when this Program actually requested it.
 */
export function isObservedJSDocumentLiteral(options: {
  literal: ts.StringLiteralLike;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): boolean {
  const flag = (options.tsModule.NodeFlags as { JSDoc?: number }).JSDoc;
  if (typeof flag !== 'number') return false;
  // Parent chains may be incomplete before binding. Use the compiler's own
  // parsed-node flag, not an ancestor walk that could admit an unobserved node.
  return (
    (options.literal.flags & flag) === 0 ||
    hasCompilerLiteral(options.sourceFile, options.literal)
  );
}

function hasCompilerLiteral(
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
): boolean {
  // The adapted inventory is optional here: absent metadata is unavailable,
  // never permission to resolve a detached JSDoc node with the checker.
  const imports = (source as ts.SourceFile & { imports?: unknown }).imports;
  return Array.isArray(imports) && imports.includes(literal);
}

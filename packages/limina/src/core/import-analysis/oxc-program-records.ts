import {
  appendOxcSpecifier,
  getOxcLiteralSpecifier,
  getRecord,
  type OxcCollectionContext,
  walkOxcNode,
} from './oxc-ast';

function collectImportTypeNode(
  context: OxcCollectionContext,
  node: Record<string, unknown>,
): void {
  if (node.type !== 'TSImportType') return;
  const source = getOxcLiteralSpecifier(node.source);
  if (source === null) return;
  appendOxcSpecifier({ context, kind: 'import-type', specifier: source });
}

function getImportEqualsExpression(node: Record<string, unknown>): unknown {
  const moduleReference = getRecord(node.moduleReference);
  if (moduleReference?.type !== 'TSExternalModuleReference') return undefined;
  return moduleReference.expression;
}

function collectImportEquals(
  context: OxcCollectionContext,
  node: Record<string, unknown>,
): void {
  if (node.type !== 'TSImportEqualsDeclaration') return;
  const argument = getOxcLiteralSpecifier(getImportEqualsExpression(node));
  if (argument === null) return;
  appendOxcSpecifier({ context, kind: 'import-equals', specifier: argument });
}

function collectProgramNode(
  context: OxcCollectionContext,
  node: Record<string, unknown>,
): void {
  collectImportTypeNode(context, node);
  collectImportEquals(context, node);
}

export function collectOxcProgramRecords(options: {
  context: OxcCollectionContext;
  program: unknown;
}): void {
  walkOxcNode(options.program, (node) =>
    collectProgramNode(options.context, node),
  );
}

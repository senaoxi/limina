import {
  appendOxcSpecifier,
  getOxcLiteralSpecifier,
  getRecord,
  type OxcCollectionContext,
  walkOxcNode,
} from './oxc-ast';
import type { ImportRecordKind } from './records';

function collectImportTypeNode(
  context: OxcCollectionContext,
  node: Record<string, unknown>,
): void {
  if (node.type !== 'TSImportType') return;
  const source = getOxcLiteralSpecifier(node.source);
  if (source === null) return;
  appendOxcSpecifier({ context, kind: 'import-type', specifier: source });
}

function isOxcIdentifier(node: unknown, name: string): boolean {
  const record = getRecord(node);
  if (record?.type !== 'Identifier') return false;
  return record.name === name;
}

function getCallFirstArgument(node: Record<string, unknown>): unknown {
  if (!Array.isArray(node.arguments)) return undefined;
  return node.arguments[0];
}

function isMemberExpression(
  record: Record<string, unknown> | null,
): record is Record<string, unknown> {
  if (record === null) return false;
  return record.type === 'MemberExpression';
}

function isUncomputedMember(record: Record<string, unknown>): boolean {
  return record.computed !== true;
}

function isRequireMember(record: Record<string, unknown>): boolean {
  if (!isUncomputedMember(record)) return false;
  return isOxcIdentifier(record.object, 'require');
}

function isRequireResolveCallee(callee: unknown): boolean {
  const record = getRecord(callee);
  if (!isMemberExpression(record)) return false;
  if (!isRequireMember(record)) return false;
  return isOxcIdentifier(record.property, 'resolve');
}

function getCallImportKind(
  node: Record<string, unknown>,
): ImportRecordKind | null {
  if (isRequireResolveCallee(node.callee)) return 'require-resolve';
  if (isOxcIdentifier(node.callee, 'require')) return 'commonjs';
  return null;
}

function appendCallSpecifier(options: {
  context: OxcCollectionContext;
  kind: ImportRecordKind;
  node: Record<string, unknown>;
}): void {
  const argument = getOxcLiteralSpecifier(getCallFirstArgument(options.node));
  if (argument === null) return;
  appendOxcSpecifier({
    context: options.context,
    kind: options.kind,
    specifier: argument,
  });
}

function collectCallExpression(
  context: OxcCollectionContext,
  node: Record<string, unknown>,
): void {
  if (node.type !== 'CallExpression') return;
  const kind = getCallImportKind(node);
  if (kind === null) return;
  appendCallSpecifier({ context, kind, node });
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
  collectCallExpression(context, node);
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

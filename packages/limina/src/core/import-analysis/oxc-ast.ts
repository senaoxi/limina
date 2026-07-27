import type { CollectedImportRecord, ImportRecordKind } from './records';
import { createImportRecord } from './records';

export interface OxcLiteralSpecifier {
  end?: number;
  pos: number;
  specifier: string;
}

export interface OxcCollectionContext {
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  records: CollectedImportRecord[];
  sourceOffset: number;
}

type OxcNodeVisitor = (node: Record<string, unknown>) => void;

function isNonArrayObject(value: unknown): value is object {
  if (value === null) return false;
  return typeof value === 'object' && !Array.isArray(value);
}

export function getRecord(value: unknown): Record<string, unknown> | null {
  if (!isNonArrayObject(value)) return null;
  return value as Record<string, unknown>;
}

function getOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return value;
}

function hasLiteralType(record: Record<string, unknown>): boolean {
  if (record.type === 'Literal') return true;
  return record.type === 'StringLiteral';
}

function hasLiteralCoordinates(record: Record<string, unknown>): boolean {
  if (typeof record.value !== 'string') return false;
  return typeof record.start === 'number';
}

function getLiteralSpecifier(
  record: Record<string, unknown>,
): OxcLiteralSpecifier | null {
  if (!hasLiteralType(record)) return null;
  if (!hasLiteralCoordinates(record)) return null;
  return {
    end: getOptionalNumber(record.end),
    pos: record.start as number,
    specifier: record.value as string,
  };
}

function getCookedQuasi(value: Record<string, unknown>): string | null {
  if (typeof value.cooked !== 'string') return null;
  return value.cooked;
}

function getRawQuasi(value: Record<string, unknown>): string | null {
  if (typeof value.raw !== 'string') return null;
  return value.raw;
}

function getQuasiValue(quasi: unknown): Record<string, unknown> | null {
  const quasiRecord = getRecord(quasi);
  if (quasiRecord === null) return null;
  return getRecord(quasiRecord.value);
}

function getTemplateQuasiText(quasi: unknown): string | null {
  const value = getQuasiValue(quasi);
  if (value === null) return null;
  return getCookedQuasi(value) ?? getRawQuasi(value);
}

function hasNoTemplateExpressions(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.expressions)) return false;
  return record.expressions.length === 0;
}

function hasOneTemplateQuasi(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.quasis)) return false;
  return record.quasis.length === 1;
}

function isStaticTemplate(record: Record<string, unknown>): boolean {
  if (record.type !== 'TemplateLiteral') return false;
  if (!hasNoTemplateExpressions(record)) return false;
  return hasOneTemplateQuasi(record);
}

function createTemplateSpecifier(
  record: Record<string, unknown>,
  specifier: string,
): OxcLiteralSpecifier | null {
  if (typeof record.start !== 'number') return null;
  return {
    end: getOptionalNumber(record.end),
    pos: record.start,
    specifier,
  };
}

function getTemplateSpecifier(
  record: Record<string, unknown>,
): OxcLiteralSpecifier | null {
  if (!isStaticTemplate(record)) return null;
  const quasis = record.quasis as unknown[];
  const specifier = getTemplateQuasiText(quasis[0]);
  if (specifier === null) return null;
  return createTemplateSpecifier(record, specifier);
}

export function getOxcLiteralSpecifier(
  node: unknown,
): OxcLiteralSpecifier | null {
  const record = getRecord(node);
  if (record === null) return null;
  return getLiteralSpecifier(record) ?? getTemplateSpecifier(record);
}

function visitArray(node: unknown[], visit: OxcNodeVisitor): void {
  for (const item of node) walkOxcNode(item, visit);
}

function visitRecordChildren(
  record: Record<string, unknown>,
  visit: OxcNodeVisitor,
): void {
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'parent') walkOxcNode(value, visit);
  }
}

export function walkOxcNode(node: unknown, visit: OxcNodeVisitor): void {
  if (Array.isArray(node)) {
    visitArray(node, visit);
    return;
  }
  const record = getRecord(node);
  if (record === null) return;
  visit(record);
  visitRecordChildren(record, visit);
}

export function appendOxcSpecifier(options: {
  context: OxcCollectionContext;
  kind: ImportRecordKind;
  specifier: OxcLiteralSpecifier;
}): void {
  options.context.records.push(
    createImportRecord({
      end: options.specifier.end,
      filePath: options.context.filePath,
      kind: options.kind,
      lineOffset: options.context.lineOffset,
      lineStarts: options.context.lineStarts,
      pos: options.specifier.pos,
      sourceOffset: options.context.sourceOffset,
      specifier: options.specifier.specifier,
    }),
  );
}

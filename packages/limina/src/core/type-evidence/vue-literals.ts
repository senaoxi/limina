import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { VolarSourceScript, VueProgramHandle } from './vue-provider-types';

interface LiteralLocator {
  end: number;
  specifier: string;
  start: number;
}

function createLocator(importRecord: ImportRecord): LiteralLocator {
  return {
    end: importRecord.locator.sourceEnd,
    specifier: importRecord.specifier,
    start: importRecord.locator.sourceStart,
  };
}

function hasLiteralText(
  node: ts.Node,
  specifier: string,
): node is ts.StringLiteralLike {
  return ts.isStringLiteralLike(node) && node.text === specifier;
}

function hasLiteralRange(
  node: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
  rangeIdentity: string,
): boolean {
  return (
    JSON.stringify([node.getStart(sourceFile), node.getEnd()]) === rangeIdentity
  );
}

function matchLocatorNode(options: {
  locator: LiteralLocator;
  node: ts.Node;
  rangeIdentity: string;
  sourceFile: ts.SourceFile;
}): ts.StringLiteralLike | null {
  if (!hasLiteralText(options.node, options.locator.specifier)) {
    return null;
  }
  return hasLiteralRange(
    options.node,
    options.sourceFile,
    options.rangeIdentity,
  )
    ? options.node
    : null;
}

function findFirstLiteral(options: {
  locator: LiteralLocator;
  sourceFile: ts.SourceFile;
}): ts.StringLiteralLike | null {
  let matched: ts.StringLiteralLike | null = null;
  const rangeIdentity = JSON.stringify([
    options.locator.start,
    options.locator.end,
  ]);

  const visit = (node: ts.Node): void => {
    if (matched !== null) {
      return;
    }
    const literal = matchLocatorNode({
      locator: options.locator,
      node,
      rangeIdentity,
      sourceFile: options.sourceFile,
    });
    if (literal !== null) {
      matched = literal;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(options.sourceFile);
  return matched;
}

export function collectNativeModuleLiteral(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): ts.StringLiteralLike[] | null {
  const sourceFile = options.handle.program.getSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  if (sourceFile === undefined) {
    return null;
  }
  const matched = findFirstLiteral({
    locator: createLocator(options.importRecord),
    sourceFile,
  });
  return matched === null ? null : [matched];
}

function getServiceScript(
  sourceScript: VolarSourceScript,
):
  | { code: Parameters<VueProgramHandle['language']['maps']['get']>[0] }
  | undefined {
  const generated = sourceScript.generated;
  return generated?.languagePlugin.typescript?.getServiceScript(generated.root);
}

function collectGeneratedRanges(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
  sourceScript: VolarSourceScript;
}): readonly (readonly [number, number, unknown, unknown])[] | null {
  const serviceScript = getServiceScript(options.sourceScript);
  if (serviceScript === undefined) {
    return null;
  }
  const mapper = options.handle.language.maps.get(
    serviceScript.code,
    options.sourceScript,
  );
  return [
    ...mapper.toGeneratedRange(
      options.importRecord.locator.sourceStart,
      options.importRecord.locator.sourceEnd,
      true,
    ),
  ];
}

function createRangeIdentities(
  ranges: readonly (readonly [number, number, unknown, unknown])[],
): Set<string> {
  return new Set(ranges.map(([start, end]) => JSON.stringify([start, end])));
}

function getNodeRangeIdentity(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  return JSON.stringify([node.getStart(sourceFile), node.getEnd()]);
}

function collectLiteralsInRanges(options: {
  importRecord: ImportRecord;
  rangeIdentities: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}): ts.StringLiteralLike[] {
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (
      hasLiteralText(node, options.importRecord.specifier) &&
      options.rangeIdentities.has(
        getNodeRangeIdentity(node, options.sourceFile),
      )
    ) {
      literals.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return literals;
}

function hasGeneratedRanges(
  ranges: readonly (readonly [number, number, unknown, unknown])[] | null,
): ranges is readonly (readonly [number, number, unknown, unknown])[] {
  return ranges !== null && ranges.length > 0;
}

function resolveGeneratedRanges(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): readonly (readonly [number, number, unknown, unknown])[] | null {
  const sourceScript = options.handle.language.scripts.get(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  if (sourceScript === undefined) {
    return null;
  }
  const ranges = collectGeneratedRanges({ ...options, sourceScript });
  return hasGeneratedRanges(ranges) ? ranges : null;
}

export function collectMappedModuleLiterals(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): ts.StringLiteralLike[] | null {
  const generatedRanges = resolveGeneratedRanges(options);
  if (generatedRanges === null) {
    return null;
  }
  const sourceFile = options.handle.program.getSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  if (sourceFile === undefined) {
    return null;
  }
  return collectLiteralsInRanges({
    importRecord: options.importRecord,
    rangeIdentities: createRangeIdentities(generatedRanges),
    sourceFile,
  });
}

export function collectVueModuleLiterals(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): ts.StringLiteralLike[] | null {
  return options.importRecord.filePath.toLowerCase().endsWith('.vue')
    ? collectMappedModuleLiterals(options)
    : collectNativeModuleLiteral(options);
}

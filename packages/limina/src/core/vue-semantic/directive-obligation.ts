import type { CompilationObligationProof } from '../dependency-semantics';
import { rangeIdentity } from '../framework-semantic/generated-dependencies';
import type { ImportRecord } from '../import-analysis/records';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { nativeTargetEligibility } from '../typescript-semantic/native-module-impact';
import { selectNativePath } from '../typescript-semantic/native-path-selection';
import { nativeObservedProgram } from '../typescript-semantic/native-program-api';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import type { VueSemanticContext } from './context';
import { getVueMappedRangeIdentities } from './dependency';

export function vueDirectiveObligation(
  context: VueSemanticContext,
  record: ImportRecord,
): CompilationObligationProof {
  const proof: CompilationObligationProof = {
    state: 'unknown',
    contextConfig: context.identity.configPath,
    reason: 'compiler-directive-observation-unavailable',
    requests: [],
  };
  const source = context.program.getSourceFile(record.filePath);
  if (source === undefined) return proof;
  const isPath = record.kind === 'triple-slash-path';
  const ranges = context.identity.profilesByFileName.has(record.filePath)
    ? getVueMappedRangeIdentities({ context, importRecord: record })
    : new Set([
        rangeIdentity(record.locator.sourceStart, record.locator.sourceEnd),
      ]);
  if (ranges === null) return proof;
  const reference = (
    isPath ? source.referencedFiles : source.typeReferenceDirectives
  ).find(
    (entry) =>
      entry.fileName === record.specifier &&
      ranges.has(rangeIdentity(entry.pos - 1, entry.end + 1)),
  );
  if (reference === undefined)
    return { ...proof, state: 'absent', reason: 'not-a-compiler-directive' };
  proof.requests.push({
    fileName: source.fileName,
    start: reference.pos,
    end: reference.end,
    specifier: reference.fileName,
    mode: undefined,
    role: isPath ? 'path-directive' : 'type-directive',
    target: null,
  });
  const program = nativeObservedProgram(
    context.program,
    context.tsModule,
    new Map(),
  );
  const options = program.getCompilerOptionsForFile(source);
  if (options === undefined) return proof;
  if (!isPath) {
    const target = program.getResolvedTypeReferenceDirective(
      source,
      record.specifier,
      reference.resolutionMode ?? source.impliedNodeFormat,
    )?.resolvedTypeReferenceDirective?.resolvedFileName;
    proof.requests[0]!.target = target ?? null;
    return target !== undefined && isDeclarationFile(target)
      ? {
          ...proof,
          state: 'absent',
          reason: 'declaration-consumption-does-not-establish-a-producer',
        }
      : proof;
  }
  const receipt = selectNativePath({
    source,
    reference,
    options,
    compiler: context.tsModule,
    host: {
      fileExists: context.sys.fileExists,
      getCanonicalFileName: (file) =>
        context.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
    },
    redirect: (target) =>
      observeProjectReferenceRedirect(program, target, context.tsModule),
  });
  const target = receipt.selection.logicalTarget;
  proof.requests[0]!.target = target;
  if (receipt.selection.state === 'unavailable') return proof;
  const hasAbsence = [
    options.noResolve,
    target === null,
    receipt.redirect !== undefined,
    target !== null && isDeclarationFile(target),
    target !== null && program.getRootFileNames().includes(target),
    program.isSourceFileFromExternalLibrary(source),
  ].some(Boolean);
  if (hasAbsence)
    return {
      ...proof,
      state: 'absent',
      reason: 'compiler-directive-has-no-cross-unit-input',
    };
  const impact = nativeTargetEligibility({
    target: target!,
    compiler: context.tsModule,
    emitOptions: program.getCompilerOptions(),
  });
  return {
    ...proof,
    state: impact.state,
    reason: 'rule' in impact ? impact.rule : impact.reason,
  };
}

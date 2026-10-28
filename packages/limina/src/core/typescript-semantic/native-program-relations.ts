import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type {
  NativeProjectRelation,
  NativeTraversalLink,
} from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { nativeFingerprint } from './native-file-identity';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeRequestResult } from './native-program-request-data';

export function nativeTraversalLinks(options: {
  entries: readonly NativeRequestResult[];
  roots: readonly string[];
}): NativeTraversalLink[] {
  const incoming = incomingRequests(options.entries);
  const roots = new Set(options.roots.map(normalizeAbsolutePath));
  return options.entries.map(({ request }) =>
    traversalLink(request, incoming, roots),
  );
}

function incomingRequests(entries: readonly NativeRequestResult[]) {
  const incoming = new Map<string, string[]>();
  for (const entry of entries) addIncomingRequest(incoming, entry);
  return incoming;
}

function addIncomingRequest(
  incoming: Map<string, string[]>,
  entry: NativeRequestResult,
) {
  const target = entry.resolution.target?.lexicalPath;
  if (target === undefined) return;
  appendIncoming(incoming, target, entry.request.id);
}

function appendIncoming(
  incoming: Map<string, string[]>,
  target: string,
  requestId: string,
) {
  const ids = incoming.get(target) ?? [];
  ids.push(requestId);
  incoming.set(target, ids);
}

function traversalLink(
  request: NativeRequestResult['request'],
  incoming: ReadonlyMap<string, string[]>,
  roots: ReadonlySet<string>,
): NativeTraversalLink {
  const file = request.sourceFile;
  return {
    requestId: request.id,
    parentRequestIds:
      file === null ? [] : parentRequests(incoming, file.lexicalPath),
    rootFileNames: rootEntries(roots, file),
  };
}

function parentRequests(incoming: ReadonlyMap<string, string[]>, file: string) {
  return incoming.get(file) ?? [];
}

function rootEntries(
  roots: ReadonlySet<string>,
  file: NativeRequestResult['request']['sourceFile'],
) {
  if (file === null) return [];
  return roots.has(file.lexicalPath) ? [file.lexicalPath] : [];
}

export function nativeProjectRelations(options: {
  context: NativeEvidenceContext;
  program: ts.Program;
  entries: readonly NativeRequestResult[];
  frontier: NativeProgramFrontier;
  obligations: readonly NativeCompilationObligation[];
}): NativeProjectRelation[] {
  const disabled = disabledModuleRequests(options.context, options.obligations);
  return [
    ...(options.program.getProjectReferences() ?? []).map((reference) => ({
      kind: 'explicit-reference' as const,
      consumerContextId: options.context.id,
      targetConfigId: normalizeAbsolutePath(
        ts.resolveProjectReferencePath(reference),
      ),
      evidenceIds: [
        nativeFingerprint([options.context.inputs.rawReferences, reference]),
      ],
    })),
    ...options.entries.flatMap((entry) =>
      targetRelations(entry, options.frontier, disabled),
    ),
    ...options.obligations.map((obligation) => ({
      kind: 'compiler-reference-obligation' as const,
      obligationId: obligation.id,
    })),
  ];
}

/** A target hit is not input authority. Only the bound request's audited
 * non-input proof cancels its contribution, never another root or request. */
function disabledModuleRequests(
  context: NativeEvidenceContext,
  obligations: readonly NativeCompilationObligation[],
): ReadonlySet<string> {
  const disabled = new Set<string>();
  for (const obligation of obligations) {
    if (
      obligation.consumerContextId !== context.id ||
      obligation.existence.state !== 'absent'
    )
      continue;
    const proof = obligation.existence.proof;
    if (
      proof.contextId === context.id &&
      proof.kind === 'audited-rule' &&
      [
        'compiler-noResolve-disables-module-input',
        'compiler-augmentation-does-not-add-input',
      ].includes(proof.ruleOrObservation) &&
      obligation.requestIds.includes(proof.evidenceId)
    )
      disabled.add(proof.evidenceId);
  }
  return disabled;
}

function targetRelations(
  entry: NativeRequestResult,
  frontier: NativeProgramFrontier,
  disabled: ReadonlySet<string>,
): NativeProjectRelation[] {
  const target = entry.resolution.target;
  if (target === null) return [];
  if (isDeclarationFile(target.lexicalPath)) {
    if (disabled.has(entry.request.id)) return [];
    return [
      {
        kind: 'declaration-consumption',
        consumerContextId: entry.request.consumerContextId,
        file: target,
        requestIds: [entry.request.id],
      },
    ];
  }
  const coverage = frontier.inspect(target.lexicalPath).coverage;
  return coverage.members.map((member) => ({
    kind: 'resolved-project-use',
    consumerContextId: entry.request.consumerContextId,
    targetConfigId: member.configId,
    coverageEvidenceId: nativeFingerprint(coverage),
    requestIds: [entry.request.id],
  }));
}

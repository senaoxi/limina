import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type {
  DeclarationReferenceRequirement,
  ProjectReferenceRedirect,
} from '../dependency-semantics';
import type { ImportRecord } from '../import-analysis/records';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { createImportRecordIdentity } from './import-record';
import type { ResolutionOrigin } from './resolution-origin';
import type { WorkspaceSourceBoundary } from './workspace-source-boundary';

export interface DeclarationEntry {
  kind: 'root' | 'type-environment' | 'framework-environment';
  fileName: string;
  name?: string;
  origin?: ResolutionOrigin;
}
export interface ClosureFact {
  target: ResolvedCheckerModuleName | null;
  referenceRequirement: DeclarationReferenceRequirement | null;
  redirect?: ProjectReferenceRedirect;
  eligibility?: { governance: boolean; expansion: boolean };
}
export interface DeclarationClosure {
  consumer: string;
  entries: DeclarationEntry[];
  entryStates: {
    governance: boolean;
    expansion: boolean;
    stop?: string;
    membership?: string[];
  }[];
  links: {
    entry: number;
    occurrence: ImportRecord;
    target: string | null;
    origin?: ResolutionOrigin;
    governance: boolean;
    expansion: boolean;
    stop?: string;
  }[];
  records: ImportRecord[];
  requirements: {
    occurrence: ImportRecord;
    requirement: DeclarationReferenceRequirement;
  }[];
  incomplete: { occurrence?: ImportRecord; fileName: string; reason: string }[];
}
interface ClosureOptions {
  configPath: string;
  entries: readonly DeclarationEntry[];
  noResolve?: boolean;
  boundary: WorkspaceSourceBoundary;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  records(file: string): readonly ImportRecord[] | undefined;
  fact(record: ImportRecord): ClosureFact;
}

function hasValidOrigin(file: string, origin?: ResolutionOrigin): boolean {
  if (origin === undefined) return false;
  return [
    origin.version === 1,
    origin.route !== 'incomplete',
    normalizeAbsolutePath(origin.target) === normalizeAbsolutePath(file),
  ].every(Boolean);
}
function isLocalTypeRoot(file: string, origin: ResolutionOrigin): boolean {
  return [
    origin.route === 'type-root',
    !origin.originalPath?.includes('/node_modules/'),
    !file.includes('/node_modules/'),
  ].every(Boolean);
}
function publicStop(options: ClosureOptions, file: string): string | undefined {
  const authority = options.boundary.governance;
  return authority === undefined
    ? 'incomplete-origin'
    : workspaceStop(authority, file);
}
function workspaceStop(
  authority: NonNullable<WorkspaceSourceBoundary['governance']>,
  file: string,
): string | undefined {
  if (!authority.isWorkspaceFile(file)) return 'external-public-declaration';
  return hasMembership(authority, file)
    ? undefined
    : 'ungoverned-workspace-public-declaration';
}
function declarationStop(
  options: ClosureOptions,
  file: string,
  origin?: ResolutionOrigin,
): string | undefined {
  if (isManagedOutput(options, file)) return 'managed-output';
  return hasValidOrigin(file, origin)
    ? localOrPublicStop(options, file, origin!)
    : 'incomplete-origin';
}
function localOrPublicStop(
  options: ClosureOptions,
  file: string,
  origin: ResolutionOrigin,
): string | undefined {
  return [origin.route === 'local', isLocalTypeRoot(file, origin)].some(Boolean)
    ? undefined
    : publicStop(options, file);
}
function entryStop(
  options: ClosureOptions,
  entry: DeclarationEntry,
): string | undefined {
  if (entry.kind !== 'root')
    return declarationStop(options, entry.fileName, entry.origin);
  return isManagedOutput(options, entry.fileName)
    ? 'managed-output'
    : undefined;
}
function occurrenceEligibility(fact: ClosureFact, occurrence: ImportRecord) {
  return (
    fact.eligibility ?? {
      governance: true,
      expansion: occurrence.kind !== 'module-augmentation',
    }
  );
}
function targetStop(
  options: ClosureOptions,
  fact: ClosureFact,
  canExpand: boolean,
): string | undefined {
  const target = targetPath(fact);
  if (target === undefined) return 'unresolved';
  return isDeclarationFile(target)
    ? declarationTargetStop(options, fact.target!, canExpand)
    : 'implementation';
}
function declarationTargetStop(
  options: ClosureOptions,
  target: ResolvedCheckerModuleName,
  canExpand: boolean,
): string | undefined {
  return [!canExpand, options.noResolve].some(Boolean)
    ? 'expansion-disabled'
    : declarationStop(
        options,
        target.resolvedFileName,
        target.resolutionOrigin,
      );
}
function occurrenceStop(
  options: ClosureOptions,
  fact: ClosureFact,
  occurrence: ImportRecord,
): string | undefined {
  const eligibility = occurrenceEligibility(fact, occurrence);
  if (!eligibility.governance) return 'ineligible-occurrence';
  return fact.redirect
    ? 'project-reference-redirect'
    : targetStop(options, fact, eligibility.expansion);
}
interface Traversal {
  options: ClosureOptions;
  projection: DeclarationClosure;
  retained: Set<string>;
  entry: number;
}
function retainOccurrence(
  state: Traversal,
  link: DeclarationClosure['links'][number],
  fact: ClosureFact,
): void {
  const key = createImportRecordIdentity(link.occurrence);
  if (state.retained.has(key)) return;
  state.retained.add(key);
  state.projection.records.push(link.occurrence);
  if (fact.referenceRequirement !== null)
    state.projection.requirements.push({
      occurrence: link.occurrence,
      requirement: fact.referenceRequirement,
    });
  retainIncomplete(state.projection, link);
}
function retainIncomplete(
  projection: DeclarationClosure,
  link: DeclarationClosure['links'][number],
): void {
  if (link.stop === 'incomplete-origin')
    projection.incomplete.push({
      occurrence: link.occurrence,
      fileName: link.target!,
      reason: link.stop,
    });
}
function visitOccurrence(
  state: Traversal,
  occurrence: ImportRecord,
): string | undefined {
  const fact = state.options.fact(occurrence);
  const stop = occurrenceStop(state.options, fact, occurrence);
  const link = {
    entry: state.entry,
    occurrence,
    target: targetOrNull(fact),
    origin: originOf(fact),
    governance: occurrenceEligibility(fact, occurrence).governance,
    expansion: stop === undefined,
    stop,
  };
  state.projection.links.push(link);
  if (link.governance) retainOccurrence(state, link, fact);
  return link.expansion ? link.target! : undefined;
}
function visitFile(state: Traversal, file: string): string[] {
  const records = state.options.records(file);
  if (records === undefined) {
    state.projection.incomplete.push({
      fileName: file,
      reason: 'unavailable-declaration-input',
    });
    return [];
  }
  return records.flatMap((record) => visitOccurrence(state, record) ?? []);
}
function traverseEntry(state: Traversal, entry: DeclarationEntry): void {
  const pending = [entry.fileName];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = normalizeAbsolutePath(pending.shift()!);
    if (visited.has(file)) continue;
    visited.add(file);
    pending.push(...visitFile(state, file));
  }
}
function projectEntry(state: Traversal, entry: DeclarationEntry): void {
  const stop = entryStop(state.options, entry);
  state.projection.entryStates.push({
    governance: stop === undefined,
    expansion: stop === undefined,
    stop,
    membership: entryMembership(state.options, entry.fileName),
  });
  if (stop === 'incomplete-origin')
    state.projection.incomplete.push({
      fileName: entry.fileName,
      reason: stop,
    });
  else if (stop === undefined) traverseEntry(state, entry);
}
// Projection never changes compiler admission, roots, or raw requirements.
export function projectDeclarationClosure(
  options: ClosureOptions,
): DeclarationClosure {
  const projection: DeclarationClosure = {
    consumer: options.configPath,
    entries: structuredClone([...options.entries]),
    entryStates: [],
    links: [],
    records: [],
    requirements: [],
    incomplete: [],
  };
  const retained = new Set<string>();
  for (const [entry, provenance] of options.entries.entries())
    projectEntry({ options, projection, retained, entry }, provenance);
  return projection;
}

function isManagedOutput(options: ClosureOptions, file: string): boolean {
  return Boolean(options.managedOutputLookup?.resolve(file));
}
function targetPath(fact: ClosureFact): string | undefined {
  return fact.target?.resolvedFileName;
}
function originOf(fact: ClosureFact): ResolutionOrigin | undefined {
  return fact.target?.resolutionOrigin;
}
function entryMembership(
  options: ClosureOptions,
  file: string,
): string[] | undefined {
  return options.boundary.governance?.membership.get(file);
}

function targetOrNull(fact: ClosureFact): string | null {
  return targetPath(fact) ?? null;
}

function hasMembership(
  authority: NonNullable<WorkspaceSourceBoundary['governance']>,
  file: string,
): boolean {
  return (authority.membership.get(file) ?? []).length > 0;
}

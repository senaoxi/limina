import type { ResolvedCheckerModuleName } from '#checkers';
import type { PreparedDependencyFact } from '../framework-semantic/contracts';
import type { ImportRuntimeResolutionEvidence } from '../import-analysis/evidence';
import type { ImportRecord } from '../import-analysis/records';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type { ProjectDependencyRequest } from './contracts';
import {
  getProjectSemanticCacheIdentity,
  getWorkspaceSourceBoundarySnapshotIdentity,
} from './identity';

type CheckerEvidence =
  | { kind: 'native'; fact: NativeDependencyFact }
  | { kind: 'framework'; fact: PreparedDependencyFact }
  | {
      kind: 'direct';
      target: ResolvedCheckerModuleName | null;
      typeScriptResolution: ResolvedCheckerModuleName | null;
      semantic?: Omit<
        NonNullable<CanonicalImportResolutionEvidence['semanticEvidence']>,
        'profile'
      >;
      failure?: CanonicalImportResolutionEvidence['semanticFailure'];
    }
  | { kind: 'unobserved' };

type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };

export interface ProjectDependencyEvidence {
  readonly context: {
    readonly identity: string;
    readonly configPath: string;
    readonly resolverConfigPath: string;
    readonly generation: number;
    readonly packageRootDir: string;
    readonly workspaceSourceBoundaryIdentity: string;
    readonly authority: Immutable<
      ProjectDependencyRequest['context']['semanticAuthority']
    >;
  };
  readonly occurrence?: Immutable<ImportRecord>;
  readonly resolutionMode?: string;
  readonly checker: Immutable<CheckerEvidence>;
  // Undefined means not observed, not a failed runtime resolution.
  readonly runtime?: Immutable<ImportRuntimeResolutionEvidence>;
  readonly oxcResolvedFilePath?: string | null;
  readonly eligibility?: Immutable<
    CanonicalImportResolutionEvidence['eligibility']
  >;
}

function isSnapshotObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function freezeSnapshot<T>(value: T): T {
  if (!isSnapshotObject(value)) return value;
  for (const child of Object.values(value)) freezeSnapshot(child);
  return Object.freeze(value);
}

export function cloneDependencyEvidence(
  evidence: ProjectDependencyEvidence,
): ProjectDependencyEvidence {
  return freezeSnapshot(structuredClone(evidence));
}

function createContext(request: ProjectDependencyRequest) {
  return {
    identity: getProjectSemanticCacheIdentity(request),
    configPath: request.context.configPath,
    resolverConfigPath: request.context.resolverConfigPath,
    generation: request.context.generation,
    packageRootDir: request.context.packageRootDir,
    workspaceSourceBoundaryIdentity: getWorkspaceSourceBoundarySnapshotIdentity(
      request.context.workspaceSourceBoundary,
    ),
    authority: request.context.semanticAuthority,
  };
}

function createDirectCheckerEvidence(
  evidence: CanonicalImportResolutionEvidence,
): CheckerEvidence {
  const semantic = evidence.semanticEvidence;
  return {
    kind: 'direct',
    typeScriptResolution: evidence.typeScriptResolution,
    target:
      semantic === undefined ? evidence.typeScriptResolution : semantic.target,
    failure: evidence.semanticFailure,
    semantic:
      semantic === undefined
        ? undefined
        : {
            framework: semantic.framework,
            identityId: semantic.identityId,
            provenance: semantic.provenance,
            resolutionMode: semantic.resolutionMode,
            semanticSpecifier: semantic.semanticSpecifier,
            sourceRecord: semantic.sourceRecord,
            target: semantic.target,
          },
  };
}

export function createDirectDependencyEvidence(options: {
  request: ProjectDependencyRequest;
  evidence: CanonicalImportResolutionEvidence;
  importRecord: ImportRecord;
  nativeFact?: NativeDependencyFact;
  resolutionMode: string;
}): ProjectDependencyEvidence {
  return cloneDependencyEvidence({
    context: createContext(options.request),
    occurrence: options.importRecord,
    resolutionMode: options.resolutionMode,
    checker:
      options.nativeFact === undefined
        ? createDirectCheckerEvidence(options.evidence)
        : { kind: 'native', fact: options.nativeFact },
    runtime: options.evidence.runtimeEvidence,
    oxcResolvedFilePath: options.evidence.oxcResolvedFilePath,
    eligibility: options.evidence.eligibility,
  });
}

export function createPreparedDependencyEvidence(options: {
  request: ProjectDependencyRequest;
  fact: PreparedDependencyFact;
}): ProjectDependencyEvidence {
  return cloneDependencyEvidence({
    context: createContext(options.request),
    occurrence: options.fact.importRecord,
    resolutionMode: options.fact.resolutionMode,
    checker: { kind: 'framework', fact: options.fact },
  });
}

export function createUnobservedDependencyEvidence(
  request: ProjectDependencyRequest,
): ProjectDependencyEvidence {
  return cloneDependencyEvidence({
    context: createContext(request),
    checker: { kind: 'unobserved' },
  });
}

export function getDependencyCheckerTarget(
  evidence: ProjectDependencyEvidence,
): ResolvedCheckerModuleName | null {
  const checker = evidence.checker;
  if (checker.kind === 'unobserved') return null;
  return getObservedCheckerTarget(checker);
}

function getObservedCheckerTarget(
  checker: Exclude<
    ProjectDependencyEvidence['checker'],
    { kind: 'unobserved' }
  >,
): ResolvedCheckerModuleName | null {
  if (checker.kind === 'native') return checker.fact.resolution.target;
  return checker.kind === 'framework' ? checker.fact.target : checker.target;
}

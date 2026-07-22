import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import {
  type CanonicalLiminaCheckIssue,
  createTaskFailureIssue,
  type LiminaCheckIssueEvidence,
  type LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';
import type { CoverageSource } from './coverage';

export type ProofSemanticIssueCode =
  | typeof LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid
  | typeof LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage
  | typeof LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner
  | typeof LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch
  | typeof LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile;

export const PROOF_SEMANTIC_ISSUE_CODES: readonly ProofSemanticIssueCode[] = [
  LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
  LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
  LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
  LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
  LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
  LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
  LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
] satisfies readonly LiminaWritableCheckIssueCode[];

export type ProofAllowlistInvalidFacts =
  | {
      readonly configuredPath?: string;
      readonly field: string;
      readonly kind: 'config-entry';
      readonly repositoryRoot: string;
      readonly ruleIndex?: number;
      readonly value: unknown;
      readonly violation:
        | 'absolute-path'
        | 'empty-file'
        | 'empty-reason'
        | 'entry-not-object'
        | 'not-array';
    }
  | {
      readonly configuredPath: string;
      readonly coverage: readonly CoverageSource[];
      readonly kind: 'entry-coverage';
      readonly repositoryRoot: string;
      readonly resolvedPath: string;
      readonly ruleIndex: number;
      readonly sourcePath: string;
      readonly violation:
        | 'already-covered'
        | 'missing-file'
        | 'outside-source-boundary';
    };

export type ProofCheckerCoverageInvalidFacts =
  | {
      readonly checkerName: string;
      readonly configPath?: string;
      readonly kind: 'checker-entry';
      readonly violation: 'missing-config' | 'missing-generated-entry';
    }
  | {
      readonly checkerName: string;
      readonly configPath?: string;
      readonly diagnosticReason: string;
      readonly diagnosticTitle: string;
      readonly kind: 'checker-route';
      readonly projection: 'checker-entry' | 'graph' | 'target';
    }
  | {
      readonly companionProjectPath: string;
      readonly declarationProjectPath: string;
      readonly kind: 'declaration-file-set';
      readonly onlyInCompanion: readonly string[];
      readonly onlyInDeclaration: readonly string[];
    }
  | {
      readonly actual: unknown;
      readonly companionProjectPath: string;
      readonly declarationProjectPath: string;
      readonly expected: unknown;
      readonly kind: 'declaration-option-parity';
      readonly optionName: string;
    }
  | {
      readonly companionProjectPath: string;
      readonly declarationProjectPath: string;
      readonly directExtends: readonly string[];
      readonly kind: 'declaration-companion';
      readonly violation: 'missing' | 'not-extended';
    }
  | {
      readonly configPath: string;
      readonly configRole: 'build-graph' | 'declaration-leaf';
      readonly kind: 'managed-config-boundary';
    }
  | {
      readonly actual: unknown;
      readonly configPath: string;
      readonly expected: unknown;
      readonly kind: 'declaration-compiler-option';
      readonly optionName: 'composite' | 'declaration' | 'noEmit';
    }
  | {
      readonly actualFiles: unknown;
      readonly configPath: string;
      readonly extraFields: readonly string[];
      readonly kind: 'build-aggregator-shape';
      readonly missingFilesField: boolean;
    }
  | {
      readonly configPath: string;
      readonly field: 'liminaOptions.implicitRefs' | 'references';
      readonly kind: 'source-reference-role';
      readonly violation:
        | 'implicit-refs-on-solution'
        | 'references-on-source-leaf';
    }
  | {
      readonly configPath: string;
      readonly configuredPath: string;
      readonly kind: 'build-reference';
      readonly referenceIndex: number;
      readonly resolvedPath: string;
    };

export type ProofDefaultTsconfigInvalidFacts =
  | {
      readonly actualFiles: unknown;
      readonly configPath: string;
      readonly extraFields: readonly string[];
      readonly kind: 'aggregator-shape';
      readonly missingFilesField: boolean;
    }
  | {
      readonly configPath: string;
      readonly configuredPath: string;
      readonly kind: 'reference-target';
      readonly referenceIndex: number;
      readonly resolvedPath: string;
    }
  | {
      readonly defaultConfigPath: string;
      readonly directoryPath: string;
      readonly environmentConfigPaths: readonly string[];
      readonly kind: 'environment-layout';
      readonly violation:
        | 'missing-default'
        | 'multiple-environments-not-aggregated'
        | 'single-environment-uses-named-config';
    };

export interface ProofDuplicateGraphCoverageFacts {
  readonly checkerNames: readonly string[];
  readonly checkerPreset: string;
  readonly declarationProjectPaths: readonly string[];
  readonly graphEntryPaths: readonly string[];
  readonly kind: 'multiple-declaration-projects';
  readonly sourcePath: string;
}

export interface ProofDuplicateSourceOwnerFacts {
  readonly checkerNames: readonly string[];
  readonly kind: 'multiple-typecheck-owners';
  readonly ownerProjectPaths: readonly string[];
  readonly sourcePath: string;
}

export interface ProofSourceBoundaryMismatchFacts {
  readonly configuredSourceExcludes: readonly string[];
  readonly configuredSourceIncludes: readonly string[];
  readonly kind: 'coverage-outside-source-boundary';
  readonly repositoryRoot: string;
  readonly sources: readonly {
    readonly coverage: readonly CoverageSource[];
    readonly packageManifestPath?: string;
    readonly packageName?: string;
    readonly packageRoot?: string;
    readonly sourcePath: string;
  }[];
}

export interface ProofUncoveredSourceFileFacts {
  readonly candidateCheckerNames: readonly string[];
  readonly candidateProjectPaths: readonly string[];
  readonly configuredSourceExcludes: readonly string[];
  readonly configuredSourceIncludes: readonly string[];
  readonly coverage: readonly CoverageSource[];
  readonly kind: 'no-checker-or-allowlist-coverage';
  readonly sourcePath: string;
}

export interface ProofFindingFactsByCode {
  readonly [LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid]: ProofAllowlistInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid]: ProofCheckerCoverageInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid]: ProofDefaultTsconfigInvalidFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage]: ProofDuplicateGraphCoverageFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner]: ProofDuplicateSourceOwnerFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch]: ProofSourceBoundaryMismatchFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile]: ProofUncoveredSourceFileFacts;
}

export interface ProofFindingPresentation {
  readonly detailLines: readonly string[];
  readonly title: string;
}

interface ProofFindingBase<Code extends ProofSemanticIssueCode> {
  readonly checkerName?: string;
  readonly code: Code;
  readonly evidence: readonly LiminaCheckIssueEvidence[];
  readonly facts: ProofFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly hint?: string;
  readonly locations?: readonly LiminaCheckIssueLocation[];
  readonly packageManifestPath?: string;
  readonly packageName?: string;
  readonly presentation: ProofFindingPresentation;
  readonly reason: string;
  readonly scope?: string;
  readonly task: 'proof:check';
}

export type ProofFindingForCode<Code extends ProofSemanticIssueCode> =
  ProofFindingBase<Code>;

export type ProofFinding = {
  readonly [Code in ProofSemanticIssueCode]: ProofFindingForCode<Code>;
}[ProofSemanticIssueCode];

export function createProofFinding<Code extends ProofSemanticIssueCode>(
  finding: Omit<ProofFindingForCode<Code>, 'task'>,
): ProofFindingForCode<Code> {
  return {
    ...finding,
    task: 'proof:check',
  } as ProofFindingForCode<Code>;
}

export function createProofCheckIssueFromFinding(options: {
  finding: ProofFinding;
  rootDir: string;
}): CanonicalLiminaCheckIssue {
  return createTaskFailureIssue({
    checkerName: options.finding.checkerName,
    code: options.finding.code,
    detailLines: options.finding.presentation.detailLines,
    evidence: options.finding.evidence,
    filePath: options.finding.filePath,
    fix: options.finding.hint,
    locations: options.finding.locations,
    packageManifestPath: options.finding.packageManifestPath,
    packageName: options.finding.packageName,
    reason: options.finding.reason,
    rootDir: options.rootDir,
    scope: options.finding.scope,
    task: options.finding.task,
    title: options.finding.presentation.title,
  });
}

export function createProofCheckIssuesFromFindings(options: {
  findings: readonly ProofFinding[];
  rootDir: string;
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createProofCheckIssueFromFinding({
      finding,
      rootDir: options.rootDir,
    }),
  );
}

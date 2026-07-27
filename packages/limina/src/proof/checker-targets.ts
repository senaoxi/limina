import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  type CheckerGraphRouteDiagnostic,
  collectGraphProjectRouteFromRoot,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { LiminaCheckIssueLocation } from '../check-reporting/snapshot';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type {
  ProofCheckerCoverageInvalidFacts,
  ProofFinding,
  ProofFindingForCode,
} from './findings';
import type {
  CheckerCoverageTarget,
  CheckerCoverageTargetCollection,
} from './runner-types';

function createRouteLocations(
  filePath: string | undefined,
): LiminaCheckIssueLocation[] | undefined {
  if (!filePath) {
    return undefined;
  }

  return [{ filePath, label: 'checker project' }];
}

export function createProofCheckerRouteFinding(options: {
  checkerName: string;
  diagnostic: CheckerGraphRouteDiagnostic;
  projection: Extract<
    ProofCheckerCoverageInvalidFacts,
    { readonly kind: 'checker-route' }
  >['projection'];
  workspaceLookup: WorkspaceLookupIndex;
}): ProofFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid
> {
  return createProofDiagnosticFinding({
    checkerName: options.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    detailLines: options.diagnostic.detailLines,
    facts: {
      checkerName: options.checkerName,
      configPath: options.diagnostic.filePath,
      diagnosticReason: options.diagnostic.reason,
      diagnosticTitle: options.diagnostic.title,
      kind: 'checker-route',
      projection: options.projection,
    },
    filePath: options.diagnostic.filePath,
    locations: createRouteLocations(options.diagnostic.filePath),
    packageIdentity: getProofPackageIdentity(
      options.workspaceLookup,
      options.diagnostic.filePath,
    ),
    reason: options.diagnostic.reason,
    title: options.diagnostic.title,
  });
}

function createMissingEntryFinding(
  checkerName: string,
): ProofFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid
> {
  const detailLines = [
    'Checker proof entry is missing a generated tsconfig:',
    `  checker: ${checkerName}`,
  ];

  return createProofDiagnosticFinding({
    checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    detailLines,
    facts: {
      checkerName,
      kind: 'checker-entry',
      violation: 'missing-generated-entry',
    },
    reason:
      'Every active checker needs a generated entry tsconfig before proof can validate coverage.',
    title: 'Checker proof entry is missing a generated tsconfig',
  });
}

function createMissingConfigFinding(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  configPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): ProofFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid
> {
  const detailLines = [
    'Checker proof entry references a missing tsconfig:',
    `  checker: ${options.checkerName}`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
  ];

  return createProofDiagnosticFinding({
    checkerName: options.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    detailLines,
    facts: {
      checkerName: options.checkerName,
      configPath: options.configPath,
      kind: 'checker-entry',
      violation: 'missing-config',
    },
    filePath: options.configPath,
    locations: [{ filePath: options.configPath, label: 'checker entry' }],
    packageIdentity: getProofPackageIdentity(
      options.workspaceLookup,
      options.configPath,
    ),
    reason:
      'The generated checker entry referenced by proof no longer exists on disk.',
    title: 'Checker proof entry references a missing tsconfig',
  });
}

function checkerEntryExists(
  configPath: string,
  generatedFiles: ReadonlyMap<string, string>,
): boolean {
  return (
    existsSync(configPath) ||
    generatedFiles.has(normalizeAbsolutePath(configPath))
  );
}

interface ResolvedCheckerTarget {
  findings: ProofFinding[];
  target?: CheckerCoverageTarget;
}

function resolveCheckerTarget(options: {
  checker: GeneratedTsconfigGraphResult['checkers'][number];
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceLookup: WorkspaceLookupIndex;
}): ResolvedCheckerTarget {
  const configPath = options.generatedGraph.checkerEntries.get(
    options.checker.name,
  );

  if (!configPath) {
    return { findings: [createMissingEntryFinding(options.checker.name)] };
  }

  if (!checkerEntryExists(configPath, options.generatedGraph.generatedFiles)) {
    return {
      findings: [
        createMissingConfigFinding({
          checkerName: options.checker.name,
          config: options.config,
          configPath,
          workspaceLookup: options.workspaceLookup,
        }),
      ],
    };
  }

  const routeCollection = collectGraphProjectRouteFromRoot({
    rootConfigPath: configPath,
    rootDir: options.config.rootDir,
    virtualFiles: options.generatedGraph.generatedFiles,
  });
  const findings = routeCollection.diagnostics.map((diagnostic) =>
    createProofCheckerRouteFinding({
      checkerName: options.checker.name,
      diagnostic: { checkerName: options.checker.name, ...diagnostic },
      projection: 'target',
      workspaceLookup: options.workspaceLookup,
    }),
  );

  return {
    findings,
    target: {
      checker: options.checker,
      configPath,
      coverageConfigPaths: routeCollection.projectPaths,
      label: `${options.checker.name}:entry`,
    },
  };
}

export function collectCheckerCoverageTargets(
  config: ResolvedLiminaConfig,
  generatedGraph: GeneratedTsconfigGraphResult,
  workspaceLookup: WorkspaceLookupIndex,
): CheckerCoverageTargetCollection {
  const findings: ProofFinding[] = [];
  const targets: CheckerCoverageTarget[] = [];

  for (const checker of generatedGraph.checkers) {
    const resolved = resolveCheckerTarget({
      checker,
      config,
      generatedGraph,
      workspaceLookup,
    });

    findings.push(...resolved.findings);
    if (resolved.target) {
      targets.push(resolved.target);
    }
  }

  return { findings, targets };
}

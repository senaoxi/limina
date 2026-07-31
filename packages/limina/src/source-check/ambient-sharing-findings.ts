import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';
import type {
  AmbientConsumersByFile,
  GovernanceUnit,
} from './tsconfig-governance-types';

function shouldReportSharedAmbient(options: {
  allowSharedAcrossOwners: boolean;
  consumerCount: number;
}): boolean {
  const conditions = [
    options.consumerCount > 1,
    !options.allowSharedAcrossOwners,
  ];

  return conditions.every(Boolean);
}

function sortConsumers(
  consumers: Map<string, GovernanceUnit>,
): GovernanceUnit[] {
  return [...consumers.values()].sort((left, right) =>
    compareCodeUnits(left.owner.packageJsonPath, right.owner.packageJsonPath),
  );
}

function createConsumerLines(
  config: ResolvedLiminaConfig,
  consumers: GovernanceUnit[],
): string[] {
  return consumers.flatMap((consumer) => [
    `    - ${toRelativePath(config.rootDir, consumer.owner.packageJsonPath)}`,
    ...consumer.configPaths
      .sort(compareCodeUnits)
      .map(
        (configPath) =>
          `      config: ${toRelativePath(config.rootDir, configPath)}`,
      ),
  ]);
}

function addSharedAmbientFinding(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consumers: Map<string, GovernanceUnit>;
  fileName: string;
  findings: SourceFinding[];
}): void {
  options.checks.add();
  const policy = options.ambientDeclarations.get(options.fileName);
  if (!policy) {
    return;
  }

  if (
    !shouldReportSharedAmbient({
      allowSharedAcrossOwners: policy.allowSharedAcrossOwners,
      consumerCount: options.consumers.size,
    })
  ) {
    return;
  }

  const title =
    'Ambient declaration is shared across source owners without authorization';
  const reason =
    'more than one distinct source owner consumes this ambient declaration, but allowSharedAcrossOwners is false.';
  const fix =
    'set allowSharedAcrossOwners: true or narrow the ambient include and consuming tsconfig file sets.';
  const sortedConsumers = sortConsumers(options.consumers);
  const ruleIdentity = `source.declarations.ambient[${policy.ruleIndex}]`;
  const lines = [
    `${title}:`,
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    `  rule: ${ruleIdentity}`,
    '  source owners:',
    ...createConsumerLines(options.config, sortedConsumers),
    `  configured reason: ${policy.reason}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
      facts: {
        consumers: sortedConsumers.map((consumer) => ({
          configPaths: consumer.configPaths,
          packageManifestPath: consumer.owner.packageJsonPath,
          packageName: consumer.owner.name ?? undefined,
        })),
        declarationPath: options.fileName,
        kind: 'shared-across-owners',
        ruleIdentity,
        ruleIndex: policy.ruleIndex,
      },
      filePath: options.fileName,
      fix,
      lines,
      reason,
      scope: ruleIdentity,
      title,
    }),
  );
}

export function addAmbientSharingFindings(options: {
  ambientConsumersByFile: AmbientConsumersByFile;
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
}): void {
  const entries = [...options.ambientConsumersByFile.entries()].sort(
    ([left], [right]) => compareCodeUnits(left, right),
  );

  for (const [fileName, consumers] of entries) {
    addSharedAmbientFinding({ ...options, consumers, fileName });
  }
}

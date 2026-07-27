import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import type { CheckCounter } from '../../check-reporting/stats';
import type { GeneratedKnipPackageDiagnostic } from '../../core/build-graph/generated-knip';
import { createSourceDiagnosticFinding } from '../finding-utils';
import type { SourceFinding } from '../findings';

function createOptionalLine(
  label: string,
  value: string | undefined,
): string[] {
  return value ? [`  ${label}: ${value}`] : [];
}

function getDiagnosticOwnerName(
  diagnostic: GeneratedKnipPackageDiagnostic,
): string {
  return diagnostic.packageName ?? '<unnamed>';
}

function getDiagnosticPackageName(
  diagnostic: GeneratedKnipPackageDiagnostic,
): string | undefined {
  return diagnostic.packageName ?? undefined;
}

function addKnipDiagnostic(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  diagnostic: GeneratedKnipPackageDiagnostic;
  findings: SourceFinding[];
}): void {
  options.checks.add();
  const title = 'Unsupported package build script for generated Knip tsconfig';
  const ownerName = getDiagnosticOwnerName(options.diagnostic);
  const packageName = getDiagnosticPackageName(options.diagnostic);
  const lines = [
    `${title}:`,
    `  package: ${ownerName}`,
    `  package manifest: ${toRelativePath(options.config.rootDir, options.diagnostic.packageJsonPath)}`,
    ...createOptionalLine('script', options.diagnostic.scriptName),
    ...createOptionalLine('command', options.diagnostic.command),
    `  reason: ${options.diagnostic.reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
      external: { tool: 'knip' },
      facts: {
        command: options.diagnostic.command,
        kind: 'unsupported-build-script',
        packageManifestPath: options.diagnostic.packageJsonPath,
        packageName,
        scriptName: options.diagnostic.scriptName,
      },
      lines,
      ownerName,
      packageJsonPath: options.diagnostic.packageJsonPath,
      reason: options.diagnostic.reason,
      title,
      tool: 'knip',
    }),
  );
}

export function addGeneratedKnipDiagnostics(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  diagnostics: GeneratedKnipPackageDiagnostic[];
  findings: SourceFinding[];
}): void {
  for (const diagnostic of options.diagnostics) {
    addKnipDiagnostic({ ...options, diagnostic });
  }
}

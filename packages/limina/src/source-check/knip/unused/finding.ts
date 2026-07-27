import type {
  SourceFinding,
  SourceKnipConfigInvalidFacts,
} from '../../findings';
import { createSourceKnipConfigFinding } from '../../findings';

export function addKnipConfigFinding(options: {
  dependencyName?: string;
  details?: readonly string[];
  field: string;
  file?: string;
  findings: SourceFinding[];
  importerName?: string;
  kind: SourceKnipConfigInvalidFacts['kind'];
  packageJsonPath?: string;
  packageName?: string;
  reason: string;
  title: string;
  value?: unknown;
}): void {
  const lines = [
    `${options.title}:`,
    `  field: ${options.field}`,
    ...(options.details ?? []),
    `  reason: ${options.reason}`,
  ];
  options.findings.push(
    createSourceKnipConfigFinding({
      dependencyName: options.dependencyName,
      field: options.field,
      file: options.file,
      importerName: options.importerName,
      kind: options.kind,
      lines,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason: options.reason,
      title: options.title,
      value: options.value,
    }),
  );
}

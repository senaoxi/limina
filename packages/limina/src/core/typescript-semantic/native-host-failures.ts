import type ts from 'typescript';
import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { nativeFailure } from './native-observation-failure';

export interface NativeHostFailures {
  contextId: string;
  failures: NativeEvidenceFailure[];
}

export function readNativeSource(
  input: NativeHostFailures,
  fileName: string,
  read: () => ts.SourceFile | undefined,
): ts.SourceFile | undefined {
  const file = read();
  if (file === undefined)
    recordNativeReadFailure(
      input,
      fileName,
      'Compiler host could not read the admitted source.',
    );
  return file;
}

function recordNativeReadFailure(
  input: NativeHostFailures,
  fileName: string,
  detail: string,
) {
  input.failures.push(
    nativeFailure({
      contextId: input.contextId,
      kind: 'file-read',
      detail,
      entryIds: [fileName],
    }),
  );
}

export function recordNativeConfigFailure(
  input: NativeHostFailures,
  configPath: string,
  parsed: ts.ParsedCommandLine | undefined,
): void {
  if (parsed !== undefined && parsed.errors.length === 0) return;
  input.failures.push(
    nativeFailure({
      contextId: input.contextId,
      kind: 'config-parse',
      detail: configFailureDetail(parsed),
      entryIds: [configPath],
    }),
  );
}

function configFailureDetail(parsed: ts.ParsedCommandLine | undefined): string {
  const details =
    parsed === undefined
      ? 'Configuration could not be read or parsed.'
      : parsed.errors.map((error) => [error.code, error.messageText]);
  return JSON.stringify(details);
}

import type ts from 'typescript';
import type {
  SourceConfigCoverageIndex,
  SourceConfigEnumeration,
  SourceConfigUniverse,
} from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';

/**
 * U is supplied by activated entry selection and solution traversal, before
 * parsing. A successful parse cannot add an owner; a failure cannot remove one.
 * Extends and generated output configs are therefore never discovered here.
 */
export function collectSourceConfigCoverage(options: {
  universe: SourceConfigUniverse;
  parse(configId: string): ts.ParsedCommandLine | undefined;
}): SourceConfigCoverageIndex {
  const { universe } = options;
  return freezeNativeData({
    universe,
    inputVersion: universe.inputVersion,
    configurations: universe.sourceConfigIds.map((configId) =>
      enumerateSourceConfig(configId, options),
    ),
  });
}

function enumerateSourceConfig(
  configId: string,
  options: Parameters<typeof collectSourceConfigCoverage>[0],
): SourceConfigEnumeration {
  const inputVersion = options.universe.inputVersion;
  const parsed = options.parse(configId);
  if (hasParseFailure(parsed))
    return {
      configId,
      inputVersion,
      state: 'failed',
      failureId: nativeFingerprint([
        configId,
        parsed?.errors.map((error) => [error.code, error.messageText]),
      ]),
      // A config can include files outside its directory. No directory-based
      // exclusion proof is invented when parsing failed.
      impact: { kind: 'unbounded' },
    };
  const members = parsed!.fileNames.map((file) =>
    observeNativeFileIdentity(file, inputVersion),
  );
  return {
    configId,
    inputVersion,
    state: 'enumerated',
    complete: true,
    evidenceId: nativeFingerprint([configId, inputVersion, members]),
    members,
  };
}

function hasParseFailure(parsed: ts.ParsedCommandLine | undefined): boolean {
  return parsed === undefined || parsed.errors.length > 0;
}

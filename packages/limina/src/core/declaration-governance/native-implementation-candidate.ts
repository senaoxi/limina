import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import { observeNativeReferenceMapping } from '../typescript-semantic/reference-redirect';
import type {
  DeclarationCandidateInput,
  DeclarationCandidateObservation,
} from './candidate';
import { DeclarationObservationUnavailable } from './candidate';
import { proveNativeImplementationMappings } from './native-implementation-proof';

const require = createRequire(import.meta.url);

/** The compiler constructs its Reference Map from configuration metadata.
 * Keep the candidate roots/options intact, but grant no source/output reads:
 * output existence and type diagnostics do not prove a reference mapping. */
export function observeNativeImplementationCandidate(
  input: DeclarationCandidateInput,
): DeclarationCandidateObservation {
  const proof = proveNativeImplementationMappings(input);
  if (proof !== undefined) {
    input.metrics?.record({
      name: 'declaration-candidate',
      kind: 'compiler-membership',
      count: 1,
    });
    return observation(input, proof);
  }
  const system = observedCompilerSystem(ts, input.generatedConfig);
  const host = ts.createCompilerHost(input.parsed.options);
  host.readFile = (file) =>
    input.files.get(normalizeAbsolutePath(file)) ?? system.readFile(file);
  host.fileExists = (file) =>
    input.files.has(normalizeAbsolutePath(file)) || system.fileExists(file);
  host.getParsedCommandLine = (file) => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      file,
      {},
      {
        ...system,
        readFile: host.readFile,
        fileExists: host.fileExists,
        onUnRecoverableConfigFileDiagnostic: () => {
          throw new DeclarationObservationUnavailable(
            `Cannot read reference configuration: ${file}`,
          );
        },
      },
    );
    if (parsed === undefined || parsed.errors.length > 0)
      throw new DeclarationObservationUnavailable(
        `Cannot parse reference configuration: ${file}`,
      );
    return parsed;
  };
  host.getSourceFile = (): undefined => {
    // Only configuration parsing may read file content in this observer.
  };
  const start = performance.now();
  const program = ts.createProgram({
    rootNames: input.parsed.fileNames,
    options: input.parsed.options,
    projectReferences: input.parsed.projectReferences,
    host,
  });
  input.metrics?.record({
    name: 'bounded-program-create',
    kind: 'implementation-reference',
    count: 1,
    durationMs: performance.now() - start,
  });
  return observation(
    input,
    (input.referenceInputs ?? []).map((file) => {
      const mapping = observeNativeReferenceMapping(program, file, ts);
      return {
        file,
        referenceConfig: mapping.referenceConfig ?? null,
        declarationOutput: mapping.declarationOutput ?? null,
        qualified: mapping.qualified,
      };
    }),
  );
}

function observation(
  input: DeclarationCandidateInput,
  mappings: DeclarationCandidateObservation['mappings'],
): DeclarationCandidateObservation {
  return {
    authority: {
      checker: input.checker,
      adapter: 'typescript-reference-candidate-v1',
      toolchain: nativeFingerprint([require.resolve('typescript'), ts.version]),
      executionEntry: require.resolve('typescript/bin/tsc'),
    },
    contextId: nativeFingerprint([
      input.generatedConfig,
      input.parsed.fileNames,
      input.parsed.projectReferences,
    ]),
    compilerVersion: ts.version,
    sources: [],
    requests: [],
    mappings,
  };
}

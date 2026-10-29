import { readAnalysisInput } from '#utils/analysis-input';
import { isPlainRecord } from '#utils/values';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { createVueOverlaySystem } from '../../checker/vue-semantic-identity';
import { resolveVueSemanticToolchain } from '../../checker/vue-semantic-toolchain';
import { vueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import {
  type DeclarationCandidateInput,
  type DeclarationCandidateObservation,
  declarationCandidateRequests,
  DeclarationObservationUnavailable,
} from '../declaration-governance/candidate';
import { declarationRequestSchema } from '../declaration-governance/schema';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { vueCandidateWorker } from './candidate-worker';

const text = z.string();
const readSchema = z.tuple([text, text]);
const sourceSchema = z.object({ file: text, defaultLibrary: z.boolean() });
const mappingSchema = z.object({
  file: text,
  referenceConfig: text.nullable(),
  declarationOutput: text.nullable(),
  qualified: z.boolean(),
});
const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file: text, value: z.boolean() }),
  z.object({ kind: z.literal('directory'), file: text, value: z.boolean() }),
  z.object({ kind: z.literal('realpath'), file: text, value: text }),
  z.object({
    kind: z.literal('directories'),
    file: text,
    value: z.array(text),
  }),
]);
const observationSchema = z.object({
  checks: z.array(checkSchema),
  reads: z.array(readSchema),
  compilerVersion: text,
  contextId: text,
  sources: z.array(sourceSchema),
  mappings: z.array(mappingSchema),
  requests: z.array(declarationRequestSchema),
});

export function observeVueDeclarationCandidate(
  input: DeclarationCandidateInput,
): DeclarationCandidateObservation {
  const toolchain = resolveVueSemanticToolchain(
    input.executionRoot ?? path.dirname(input.sourceConfig),
  );
  if (toolchain.adapter.kind !== 'supported')
    throw new DeclarationObservationUnavailable(toolchain.adapter.reason);
  qualifyDelegationInputs(input);
  const executionEntry = createRequire(toolchain.paths.vueTsc).resolve(
    'vue-tsc/bin/vue-tsc.js',
  );
  const start = performance.now();
  const result = spawnSync(process.execPath, ['-e', vueCandidateWorker], {
    cwd: path.dirname(input.sourceConfig),
    input: JSON.stringify({
      vueTsc: toolchain.paths.vueTsc,
      generatedConfig: input.generatedConfig,
      files: [...input.files],
      declarations: input.declarations,
      configs: input.configs,
      governed: input.coverage.configurations.flatMap((config) =>
        config.state === 'enumerated'
          ? config.members.flatMap((member) =>
              member.physical.state === 'verified'
                ? [member.physical.canonicalId]
                : [],
            )
          : [],
      ),
    }),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  input.metrics?.record({
    name: 'bounded-program-create',
    count: 1,
    durationMs: performance.now() - start,
  });
  if (result.error || result.status !== 0)
    throw new DeclarationObservationUnavailable(
      `Vue declaration candidate failed: ${result.error?.message ?? result.stdout ?? result.stderr}`,
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    throw new DeclarationObservationUnavailable(
      'Vue candidate returned invalid JSON.',
    );
  }
  const parsed = observationSchema.safeParse(decoded);
  if (!parsed.success)
    throw new DeclarationObservationUnavailable(
      'Invalid Vue declaration candidate observation.',
    );
  for (const [file, expected] of parsed.data.reads) {
    const read = () =>
      readAnalysisInput(file, () => readFileSync(file, 'utf8'));
    const content =
      input.executionIdentity === undefined
        ? read()
        : vueExecutionInputs(input.executionIdentity).collect(read);
    if (createHash('sha256').update(content).digest('hex') !== expected)
      throw new DeclarationObservationUnavailable(
        `Vue candidate input changed during observation: ${file}`,
      );
  }
  const system = createVueOverlaySystem({
    tsModule: toolchain.tsModule,
    virtualFiles: input.files,
  });
  const host = observedResolutionHost(
    toolchain.tsModule,
    input.generatedConfig,
    system,
  );
  for (const check of parsed.data.checks) {
    const readLookup = () => {
      switch (check.kind) {
        case 'file': {
          return host.fileExists(check.file);
        }
        case 'directory': {
          return host.directoryExists!(check.file);
        }
        case 'realpath': {
          return host.realpath!(check.file);
        }
        case 'directories': {
          return host.getDirectories!(check.file);
        }
        default: {
          throw new DeclarationObservationUnavailable(
            'Unknown candidate lookup.',
          );
        }
      }
    };
    const actual =
      input.executionIdentity === undefined
        ? readLookup()
        : vueExecutionInputs(input.executionIdentity).collect(readLookup);
    if (JSON.stringify(actual) !== JSON.stringify(check.value))
      throw new DeclarationObservationUnavailable(
        `Vue candidate lookup changed: ${check.file}`,
      );
  }
  const requests = declarationCandidateRequests(
    input.declarations,
    parsed.data.requests,
  );
  if (requests.some((request) => request.resolutionState === 'unavailable'))
    throw new DeclarationObservationUnavailable(
      'Vue declaration candidate has an unavailable compiler request.',
    );
  return {
    ...parsed.data,
    authority: {
      checker: input.checker,
      adapter: 'vue-cli-declaration-candidate-v1',
      executionEntry,
      toolchain: nativeFingerprint([toolchain.paths, toolchain.versions]),
    },
    requests,
  };
}

function qualifyDelegationInputs(input: DeclarationCandidateInput): void {
  if (!input.requiresDelegationProof) return;
  const identity = input.executionIdentity;
  const hasPlugins = (plugins: unknown) =>
    plugins !== undefined && (!Array.isArray(plugins) || plugins.length > 0);
  if (
    identity === undefined ||
    !isPlainRecord(identity.vueOptions) ||
    hasPlugins(identity.vueOptions.plugins) ||
    identity.configClosure.some(({ filePath }) => {
      const content =
        input.files.get(filePath) ??
        readAnalysisInput(filePath, () => readFileSync(filePath, 'utf8'));
      const parsed = identity.toolchain.tsModule.parseConfigFileTextToJson(
        filePath,
        content,
      );
      return (
        parsed.error !== undefined ||
        hasPlugins(parsed.config?.vueCompilerOptions?.plugins)
      );
    })
  )
    // Arbitrary plugin filesystem/environment reads have no qualified input
    // receipt yet. Preserve local plugin analysis, but do not delegate its
    // checking responsibility using only the CompilerHost observation fence.
    throw new DeclarationObservationUnavailable(
      'Vue declaration delegation with custom plugins lacks input provenance qualification.',
    );
}

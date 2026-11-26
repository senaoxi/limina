import type { VueProjectSemanticIdentity } from '#checkers';
import {
  readAnalysisFileDigest,
  readAnalysisInput,
} from '#utils/analysis-input';
import { isPlainRecord } from '#utils/values';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import {
  type AnalysisObserver,
  currentProfile,
  type ProfileScope,
} from '../../application/analysis/observability';
import { resolveVueSemanticToolchain } from '../../checker/vue-semantic-toolchain';
import { PathBindingReplay } from '../analysis-cache/directory-fingerprint';
import { vueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import { observeWork, profileContextScope } from '../analysis-profile';
import {
  type DeclarationCandidateInput,
  type DeclarationCandidateObservation,
  declarationCandidateRequests,
  DeclarationObservationUnavailable,
} from '../declaration-governance/candidate';
import { declarationRequestSchema } from '../declaration-governance/schema';
import { compilerPathPolicy } from '../typescript-semantic/compiler-path-key';
import {
  hasSameNativeFileBinding,
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import {
  pluginResolutionsSchema,
  retainVuePluginResolutions,
} from './candidate-plugin-modules';
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
  pluginResolutions: pluginResolutionsSchema,
  reads: z.array(readSchema),
  compilerVersion: text,
  contextId: text,
  sources: z.array(sourceSchema),
  mappings: z.array(mappingSchema),
  requests: z.array(declarationRequestSchema),
});
const programWorkSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    elapsedUs: z.number().int().nonnegative(),
  })
  .refine(({ attempts, created, failed }) => attempts === created + failed);

function recordCandidateProgramWork(
  observer: AnalysisObserver,
  scope: ProfileScope,
  stderr: string,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stderr);
  } catch {
    decoded = undefined;
  }
  const work = programWorkSchema.safeParse(decoded);
  if (!work.success) {
    observer.metric(
      'vue-declaration-candidate-program-observation-unavailable',
      scope,
      'calls',
      1,
    );
    return;
  }
  const { attempts, created, failed, elapsedUs } = work.data;
  observer.metric(
    'vue-declaration-candidate-program-attempts',
    scope,
    'calls',
    attempts,
  );
  observer.metric(
    'vue-declaration-candidate-program-created',
    scope,
    'calls',
    created,
  );
  observer.metric(
    'vue-declaration-candidate-program-failed',
    scope,
    'calls',
    failed,
  );
  observer.metric(
    'vue-declaration-candidate-program-elapsed',
    scope,
    'us',
    elapsedUs,
  );
}

export function observeVueDeclarationCandidate(
  input: DeclarationCandidateInput,
  attribution: 'project' | 'aggregate' = 'project',
): DeclarationCandidateObservation {
  const toolchain = resolveVueSemanticToolchain(
    input.executionRoot ?? path.dirname(input.sourceConfig),
  );
  if (toolchain.adapter.kind !== 'supported')
    throw new DeclarationObservationUnavailable(toolchain.adapter.reason);
  qualifyDelegationInputs(input);
  const plugins =
    input.executionIdentity === undefined
      ? []
      : configuredPluginRequests(input.executionIdentity);
  const referenceInputs = input.referenceInputs ?? [];
  const isMappingOnly =
    input.declarations.length === 0 && referenceInputs.length > 0;
  const executionEntry = createRequire(toolchain.paths.vueTsc).resolve(
    'vue-tsc/bin/vue-tsc.js',
  );
  const start = performance.now();
  const observer = currentProfile();
  const scope =
    attribution === 'aggregate'
      ? undefined
      : profileContextScope(observer, {
          instance: input,
          configPath: input.sourceConfig,
          checker: input.checker,
          provider: 'vue',
          role: 'declaration-candidate',
        });
  const result = observeWork(
    observer,
    'vue-declaration-candidate-process',
    () => {
      const result = spawnSync(process.execPath, ['-e', vueCandidateWorker], {
        cwd: path.dirname(input.sourceConfig),
        input: JSON.stringify({
          vueTsc: toolchain.paths.vueTsc,
          profile: observer !== undefined,
          pluginRequests: plugins,
          expectPlugin:
            isPlainRecord(input.executionIdentity?.vueOptions) &&
            Array.isArray(input.executionIdentity.vueOptions.plugins) &&
            input.executionIdentity.vueOptions.plugins.length > 0,
          generatedConfig: input.generatedConfig,
          sourceConfig: input.sourceConfig,
          buildInfoFile: input.parsed.options.tsBuildInfoFile,
          files: [...input.files],
          declarations: input.declarations,
          referenceInputs,
          configs: input.configs,
          // The mapping-only Program reads configurations. The parent still
          // rechecks member bindings at the observation handoff.
          coverage: isMappingOnly ? undefined : input.coverage,
        }),
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (observer !== undefined)
        recordCandidateProgramWork(
          observer,
          scope ?? observer.currentScope,
          result.stderr,
        );
      input.metrics?.record({
        name: 'bounded-program-create',
        count: 1,
        durationMs: performance.now() - start,
      });
      if (result.error || result.status !== 0)
        throw new DeclarationObservationUnavailable(
          `Vue declaration candidate failed: ${result.error?.message ?? result.stdout ?? result.stderr}`,
        );
      return result;
    },
    scope,
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
  if (input.executionIdentity !== undefined) {
    retainVuePluginResolutions(
      input.executionIdentity,
      input.sourceConfig,
      parsed.data.pluginResolutions,
    );
  }
  for (const [file, expected] of parsed.data.reads) {
    const read = () => readAnalysisFileDigest(file);
    const digest =
      input.executionIdentity === undefined
        ? read()
        : vueExecutionInputs(input.executionIdentity).collect(read);
    if (digest !== expected)
      throw new DeclarationObservationUnavailable(
        `Vue candidate input changed during observation: ${file}`,
      );
  }
  const host = withVirtualResolutionFiles(
    observedResolutionHost(toolchain.tsModule, input.generatedConfig),
    input.files,
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
  assertCurrentMemberBindings(input.coverage);
  const fileKey = compilerPathPolicy(toolchain.tsModule, {
    getCurrentDirectory: () => path.dirname(input.sourceConfig),
    getCanonicalFileName: toolchain.tsModule.createCompilerHost(
      input.parsed.options,
    ).getCanonicalFileName,
  }).key;
  const requests = declarationCandidateRequests(
    input.declarations,
    parsed.data.requests,
    fileKey,
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

function assertCurrentMemberBindings(
  coverage: DeclarationCandidateInput['coverage'],
): void {
  new PathBindingReplay({ reuseLeafBindings: true }).run(() => {
    for (const config of coverage.configurations) {
      if (config.state !== 'enumerated') continue;
      for (const member of config.members) {
        if (member.physical.state !== 'verified') continue;
        const current = observeNativeFileIdentity(
          member.lexicalPath,
          coverage.inputVersion,
        );
        if (
          member.physical.inputVersion !== coverage.inputVersion ||
          current.physical.state !== 'verified' ||
          !hasSameNativeFileBinding(member, current)
        )
          throw new DeclarationObservationUnavailable(
            `Vue candidate binding changed: ${member.lexicalPath}`,
          );
      }
    }
  });
}

function configPlugins(
  identity: VueProjectSemanticIdentity,
  filePath: string,
): unknown {
  const content =
    identity.virtualFiles.get(filePath) ??
    readAnalysisInput(filePath, () => readFileSync(filePath, 'utf8'));
  const parsed = identity.toolchain.tsModule.parseConfigFileTextToJson(
    filePath,
    content,
  );
  return parsed.error === undefined
    ? parsed.config?.vueCompilerOptions?.plugins
    : null;
}

function configuredPluginRequests(
  identity: VueProjectSemanticIdentity,
): [string, string][] {
  const result: [string, string][] = [];
  for (const { filePath } of identity.configClosure) {
    const plugins = configPlugins(identity, filePath);
    if (!Array.isArray(plugins)) continue;
    for (const plugin of plugins) {
      const name = typeof plugin === 'string' ? plugin : plugin?.name;
      if (typeof name === 'string') result.push([path.dirname(filePath), name]);
    }
  }
  return result;
}

export function hasVueCandidatePlugins(
  identity: VueProjectSemanticIdentity | undefined,
): boolean {
  if (identity === undefined) return false;
  const hasPlugins = (plugins: unknown) =>
    plugins !== undefined && (!Array.isArray(plugins) || plugins.length > 0);
  return (
    !isPlainRecord(identity.vueOptions) ||
    hasPlugins(identity.vueOptions.plugins) ||
    identity.configClosure.some(({ filePath }) =>
      hasPlugins(configPlugins(identity, filePath)),
    )
  );
}

function qualifyDelegationInputs(input: DeclarationCandidateInput): void {
  if (!input.requiresDelegationProof) return;
  if (
    input.executionIdentity === undefined ||
    hasVueCandidatePlugins(input.executionIdentity)
  )
    // Arbitrary plugin filesystem/environment reads have no qualified input
    // receipt yet. Preserve local plugin analysis, but do not delegate its
    // checking responsibility using only the CompilerHost observation fence.
    throw new DeclarationObservationUnavailable(
      'Vue declaration delegation with custom plugins lacks input provenance qualification.',
    );
}

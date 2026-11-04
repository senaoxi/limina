import ts from 'typescript';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import {
  type ExternalInputObservation,
  observeTsgoExternalInputs,
} from '../typescript-semantic/tsgo-external-inputs';
import { nativeVersion } from './checker-version-conditions';
import type { PreparedTsconfigGraph } from './types';

/** Preserve the graph's TS facts; qualify only the selected execution's
 * external-input exclusion, using fresh Native observations when available. */
export async function externalLibraryCompatibilityGaps(input: {
  graph: PreparedTsconfigGraph;
  configs: ReadonlySet<string>;
  executedConfigs: ReadonlySet<string>;
  executionRoot?: string;
  cwd: string;
}): Promise<{ denied: string[]; unknown: string[] }> {
  const requests = (
    input.graph.dependencyAnalysis?.nativeEvidence ?? []
  ).flatMap(({ snapshot }) => affectedRequests(snapshot, input.configs));
  const result = { denied: [] as string[], unknown: [] as string[] };
  if (requests.length === 0) return result;
  let version: string;
  try {
    version = nativeVersion(input.executionRoot, ts.sys);
  } catch {
    version = 'unavailable';
  }
  const groups = new Map<string, typeof requests>();
  for (const entry of requests) {
    const programs = executionPrograms(input, entry.context.inputs.config);
    if (programs.length === 0 || input.executionRoot === undefined) {
      result.unknown.push(
        diagnostic(entry, version, {
          state: 'unverified',
          reason: 'The actual execution Program is unavailable.',
        }),
      );
      continue;
    }
    const configurations = new Set([entry.context.inputs.config, ...programs]);
    for (const config of configurations) {
      const group = groups.get(config) ?? [];
      group.push(entry);
      groups.set(config, group);
    }
  }
  for (const [config, entries] of groups) {
    const observations = await observeTsgoExternalInputs({
      config,
      executionRoot: input.executionRoot!,
      cwd: input.cwd,
      requests: entries,
    });
    for (const [index, observation] of observations.entries()) {
      if (observation.state === 'compatible') continue;
      const messages =
        observation.state === 'incompatible' ? result.denied : result.unknown;
      messages.push(diagnostic(entries[index]!, version, observation, config));
    }
  }
  return {
    denied: [...new Set(result.denied)],
    unknown: [...new Set(result.unknown)],
  };
}

function executionPrograms(
  input: Parameters<typeof externalLibraryCompatibilityGaps>[0],
  config: string,
): string[] {
  if (input.executedConfigs.has(config)) return [config];
  const dts = input.graph.sourceToDts.get('tsgo')?.get(config);
  const output = input.graph.configToOutputBuild.get('tsgo')?.get(config)?.path;
  return [dts, output].filter(
    (file): file is string =>
      file !== undefined && input.executedConfigs.has(file),
  );
}

function affectedRequests(
  snapshot: NativeEvidenceSnapshot,
  configs: ReadonlySet<string>,
) {
  return snapshot.contexts.flatMap((context) => {
    if (
      context.authority.phase !== 'locked' ||
      context.authority.family !== 'typescript' ||
      !configs.has(context.inputs.config)
    )
      return [];
    const ids = new Set(
      snapshot.obligations.flatMap((obligation) =>
        obligation.consumerContextId === context.id &&
        obligation.existence.state === 'absent' &&
        obligation.existence.proof.contextId === context.id &&
        obligation.existence.proof.ruleOrObservation ===
          'compiler-external-library-input-is-not-emitted-by-consumer'
          ? obligation.requestIds
          : [],
      ),
    );
    return snapshot.requests.flatMap((request) => {
      if (
        request.consumerContextId !== context.id ||
        !ids.has(request.id) ||
        (request.channel !== 'module' && request.channel !== 'implicit') ||
        !ts.isExternalModuleNameRelative(request.specifier)
      )
        return [];
      const resolution = snapshot.resolutions.find(
        (item) => item.requestId === request.id,
      );
      // A false per-request flag cannot qualify inherited Program external
      // status. A retained declaration can itself have arrived through a
      // differently classified request, suppressing this implementation input.
      return [{ context, request, resolution }];
    });
  });
}

function diagnostic(
  { context, request, resolution }: ReturnType<typeof affectedRequests>[number],
  version: string,
  observation: ExternalInputObservation,
  config = context.inputs.config,
): string {
  return [
    `Checker resolution compatibility: ${observation.state === 'incompatible' ? 'Incompatible' : 'Unverified'} (TypeScript ${context.inputs.typescriptVersion}, tsgo ${version}).`,
    `  config: ${context.inputs.config}; observed Program: ${config}`,
    `  request: ${request.id}`,
    `  source: ${request.sourceFile?.lexicalPath ?? 'unavailable'}`,
    `  module: ${request.specifier}`,
    `  TypeScript target: ${resolution?.target?.lexicalPath ?? 'unavailable'}; isExternalLibraryImport: ${resolution?.externalLibrary ?? 'unavailable'}`,
    `  tsgo target: ${observation.target ?? 'unavailable'}; isExternalLibraryImport: unavailable (no request-level resolution API); Program external: ${observation.external ?? 'unavailable'}.`,
    `  ${observation.reason}`,
    '  Strict external-input exclusion requires the same module target and a qualified Native no-emit proof; raw request metadata and Program membership are distinct observations.',
    '  Correct the observed input difference, or provide the missing Native observation capability. Existing references and source requests are preserved; adding implicitRefs alone does not prove compatibility.',
  ].join('\n');
}

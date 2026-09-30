import type { JsonObject } from 'limina/internal/migration';
import {
  type InputTopologyResult,
  isPlainRecord,
  readInputTopology,
} from 'limina/internal/migration';
import { normalizeDeclarations } from './declarations';
import { type MigrationPlanningState, planningView } from './planning-state';
import {
  outputAdoptionRejectionReason,
  proposeOutputAdoption,
} from './transform';

function missingMemberships(
  baseline: InputTopologyResult,
  candidate: InputTopologyResult,
): string[] {
  return Object.entries(baseline.reachableSources).flatMap(([entry, sources]) =>
    sources
      .filter((source) => !candidate.reachableSources[entry]?.includes(source))
      .map((source) => `${entry} -> ${source}`),
  );
}

export function missingTopologyMembers(
  baseline: InputTopologyResult,
  candidate: InputTopologyResult,
): string[] {
  const missing = [
    ...baseline.entries.filter((entry) => !candidate.entries.includes(entry)),
    ...baseline.sources.filter((source) => !candidate.sources.includes(source)),
    ...missingMemberships(baseline, candidate),
  ];
  return [...new Set(missing)].sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
}

async function readBaseline(
  state: MigrationPlanningState,
): Promise<InputTopologyResult> {
  const view = planningView(state);
  const baseline = await readInputTopology(view);
  return !baseline.workspace || baseline.entries.length === 0
    ? baseline
    : normalizeRetainedDeclarations(state, baseline);
}

async function normalizeRetainedDeclarations(
  state: MigrationPlanningState,
  baseline: InputTopologyResult,
): Promise<InputTopologyResult> {
  const validTargets = new Set(baseline.sources);
  const config = planningView(state);
  for (const source of baseline.sources)
    normalizeDeclarations({
      config,
      configPath: source,
      object: state.objects.get(source)!,
      validTargets,
      records: state.records,
    });
  return readInputTopology(planningView(state));
}

function withOutput(object: JsonObject, outputs: JsonObject): JsonObject {
  const metadata = isPlainRecord(object.liminaOptions)
    ? object.liminaOptions
    : {};
  return { ...object, liminaOptions: { ...metadata, outputs } };
}

interface OutputTrial {
  state: MigrationPlanningState;
  baseline: InputTopologyResult;
  file: string;
  proposal: JsonObject;
}

async function tryOutput(options: OutputTrial): Promise<void> {
  const { state, file, proposal, baseline } = options;
  const previous = state.objects.get(file)!;
  state.objects.set(file, withOutput(previous, proposal));
  const trial = await readInputTopology(planningView(state));
  const missing = missingTopologyMembers(baseline, trial);
  if (trial.complete && missing.length === 0) {
    state.records.push({
      configPath: file,
      kind: 'output-adopted',
      original: proposal,
      message: 'Optional output preserves the protected input topology.',
    });
    return;
  }
  state.objects.set(file, previous);
  const restored = await readInputTopology(planningView(state));
  state.records.push({
    configPath: file,
    kind: 'output-rejected',
    original: proposal,
    message:
      'Optional output failed safety, visibility, membership, or input consumption checks.',
    details: {
      diagnostics: trial.diagnostics,
      missing,
      restored: true,
      restoredCheck: {
        complete: restored.complete,
        diagnostics: restored.diagnostics,
        missing: missingTopologyMembers(baseline, restored),
      },
    },
  });
}

async function proposeAndCheck(
  state: MigrationPlanningState,
  baseline: InputTopologyResult,
  file: string,
): Promise<void> {
  const proposal = proposeOutputAdoption(state.targets.get(file)!);
  if (!proposal) {
    recordUnadoptedOutput(state, file);
    return;
  }
  if (baseline.complete) {
    await tryOutput({ state, baseline, file, proposal });
    return;
  }
  state.records.push({
    configPath: file,
    kind: 'output-rejected',
    original: proposal,
    message: 'No complete input baseline; optional adoption cannot be checked.',
  });
}

export async function adoptOptionalOutputs(
  state: MigrationPlanningState,
): Promise<void> {
  const baseline = await readBaseline(state);
  const sourceFiles = [...baseline.sources].sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
  for (const file of sourceFiles) await proposeAndCheck(state, baseline, file);
}

function recordUnadoptedOutput(
  state: MigrationPlanningState,
  file: string,
): void {
  const target = state.targets.get(file)!;
  state.records.push({
    configPath: file,
    kind: 'output-not-adopted',
    message: outputAdoptionRejectionReason(target)!,
    details: Object.fromEntries(
      [
        'noEmit',
        'outDir',
        'rootDir',
        'declaration',
        'declarationDir',
        'emitDeclarationOnly',
        'outFile',
        'declarationMap',
      ].map((key) => [key, target.effectiveConfig.options[key]]),
    ),
  });
}

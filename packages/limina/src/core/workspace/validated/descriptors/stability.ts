import type { ResolvedLiminaConfig } from '#config/runner';
import { LiminaStructuredError } from '../../../../check-reporting/errors';
import type { PackageScopeRegionBoundary } from '../../regions';
import {
  canonicalProjectedPathSync,
  createWorkspaceIssue,
  displayWorkspacePath,
  isInsideOrEqual,
} from '../shared';
import type { WorkspaceDescriptorCandidate } from '../types';

interface OutputIdentity {
  canonicalRoot: string;
  lexicalRoot: string;
}

interface StabilityState {
  candidates: WorkspaceDescriptorCandidate[];
  outputs: Set<string>;
}

interface StabilityStep extends StabilityState {
  currentKey: string;
  nextKey: string;
}

function createOutputIdentities(
  outputs: ReadonlySet<string>,
): OutputIdentity[] {
  return [...outputs].map((outputRoot) => ({
    canonicalRoot: canonicalProjectedPathSync(outputRoot),
    lexicalRoot: outputRoot,
  }));
}

function descriptorInsideOutput(
  descriptor: WorkspaceDescriptorCandidate,
  output: OutputIdentity,
): boolean {
  if (isInsideOrEqual(output.lexicalRoot, descriptor.path)) return true;
  return isInsideOrEqual(output.canonicalRoot, descriptor.canonicalPath);
}

export function outsideOutputs(
  descriptors: readonly WorkspaceDescriptorCandidate[],
  outputs: ReadonlySet<string>,
): WorkspaceDescriptorCandidate[] {
  const outputIdentities = createOutputIdentities(outputs);
  return descriptors.filter(
    (descriptor) =>
      !outputIdentities.some((output) =>
        descriptorInsideOutput(descriptor, output),
      ),
  );
}

function visibleBoundaryRoots(options: {
  candidates: readonly WorkspaceDescriptorCandidate[];
  packageBoundaries: readonly PackageScopeRegionBoundary[];
}): string[] {
  return options.packageBoundaries
    .filter((boundary) =>
      options.candidates.some(
        (candidate) => candidate.path === boundary.packageJsonPath,
      ),
    )
    .map((boundary) => boundary.rootDir);
}

function hiddenByBoundary(
  candidate: WorkspaceDescriptorCandidate,
  boundaryRoots: readonly string[],
): boolean {
  return boundaryRoots.some((boundaryRoot) => {
    if (candidate.rootDir === boundaryRoot) return false;
    return isInsideOrEqual(boundaryRoot, candidate.path);
  });
}

function classifyVisibleDescriptors(options: {
  candidates: readonly WorkspaceDescriptorCandidate[];
  packageBoundaries: readonly PackageScopeRegionBoundary[];
}): WorkspaceDescriptorCandidate[] {
  const boundaryRoots = visibleBoundaryRoots(options);
  return options.candidates.filter(
    (candidate) => !hiddenByBoundary(candidate, boundaryRoots),
  );
}

function fixedPointStateKey(options: {
  candidates: readonly WorkspaceDescriptorCandidate[];
  outputs: ReadonlySet<string>;
}): string {
  return JSON.stringify({
    candidates: options.candidates.map((candidate) => candidate.path).sort(),
    outputs: [...options.outputs].sort(),
  });
}

function collectVisibleOutputs(options: {
  explicitOutputs: ReadonlyMap<string, string>;
  packageOutputs: ReadonlySet<string>;
  visible: readonly WorkspaceDescriptorCandidate[];
}): Set<string> {
  const visibleTsconfigPaths = new Set(
    options.visible
      .filter((candidate) => candidate.kind === 'tsconfig')
      .map((candidate) => candidate.path),
  );
  const outputs = new Set(options.packageOutputs);
  for (const [producer, outputRoot] of options.explicitOutputs) {
    if (visibleTsconfigPaths.has(producer)) outputs.add(outputRoot);
  }
  return outputs;
}

function createCycleError(
  config: ResolvedLiminaConfig,
  outputs: ReadonlySet<string>,
): LiminaStructuredError {
  return new LiminaStructuredError('Workspace output set does not stabilize.', [
    createWorkspaceIssue({
      code: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
      config,
      evidence: [...outputs].map(
        (root) => `output root: ${displayWorkspacePath(config.rootDir, root)}`,
      ),
      filePath: config.configPath,
      fix: 'Remove self-output or mutually hiding tsconfig output declarations.',
      reason:
        'Descriptor visibility and tsconfig-declared output roots repeat without reaching a stable state.',
      title: 'Workspace output visibility cycle',
    }),
  ]);
}

function createStabilityStep(options: {
  current: StabilityState;
  explicitOutputs: ReadonlyMap<string, string>;
  packageBoundaries: readonly PackageScopeRegionBoundary[];
  packageOutputs: ReadonlySet<string>;
  universe: readonly WorkspaceDescriptorCandidate[];
}): StabilityStep {
  const visible = classifyVisibleDescriptors({
    candidates: options.current.candidates,
    packageBoundaries: options.packageBoundaries,
  });
  const outputs = collectVisibleOutputs({
    explicitOutputs: options.explicitOutputs,
    packageOutputs: options.packageOutputs,
    visible,
  });
  const candidates = outsideOutputs(options.universe, outputs);
  return {
    candidates,
    currentKey: fixedPointStateKey(options.current),
    nextKey: fixedPointStateKey({ candidates, outputs }),
    outputs,
  };
}

function resolveTerminalStep(options: {
  config: ResolvedLiminaConfig;
  packageBoundaries: readonly PackageScopeRegionBoundary[];
  seenStates: ReadonlySet<string>;
  step: StabilityStep;
}): StabilityState | null {
  if (options.step.currentKey === options.step.nextKey) {
    return {
      candidates: classifyVisibleDescriptors({
        candidates: options.step.candidates,
        packageBoundaries: options.packageBoundaries,
      }),
      outputs: options.step.outputs,
    };
  }
  if (options.seenStates.has(options.step.nextKey)) {
    throw createCycleError(options.config, options.step.outputs);
  }
  return null;
}

export function resolveStableDescriptors(options: {
  config: ResolvedLiminaConfig;
  explicitOutputs: ReadonlyMap<string, string>;
  packageBoundaries: readonly PackageScopeRegionBoundary[];
  packageOutputs: ReadonlySet<string>;
  universe: readonly WorkspaceDescriptorCandidate[];
}): StabilityState {
  let current: StabilityState = {
    candidates: outsideOutputs(options.universe, options.packageOutputs),
    outputs: new Set(options.packageOutputs),
  };
  const seenStates = new Set<string>();

  while (true) {
    const step = createStabilityStep({ ...options, current });
    const terminal = resolveTerminalStep({
      config: options.config,
      packageBoundaries: options.packageBoundaries,
      seenStates,
      step,
    });
    if (terminal !== null) return terminal;
    seenStates.add(step.currentKey);
    current = { candidates: step.candidates, outputs: step.outputs };
  }
}

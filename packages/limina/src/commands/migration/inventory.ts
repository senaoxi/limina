import { validateUserMaintainedLiminaTsconfigMetadata } from '#core/tsconfig/actions';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { readFile } from 'node:fs/promises';
import { readOutputOptions } from '../../core/build-graph/generated/config-readers';
import { collectWorkspaceInputSnapshot } from '../../core/workspace/validated-context';
import { validateOutputRoot } from '../../core/workspace/validated/outputs/validation';
import { formatErrorMessage } from '../../logger';
import { MigrationInputError, normalizeDeclarations } from './declarations';
import { expectedInputFailure } from './discovery';
import { assertUnambiguousMigrationText } from './jsonc-validation';
import { type MigrationPlanningState, planningView } from './planning-state';
import { readMigrationTarget } from './targets';
import { migrateTsconfigObject } from './transform';
import type { MigrationTarget } from './types';

async function capture(
  state: MigrationPlanningState,
  file: string,
): Promise<void> {
  try {
    state.snapshot.set(file, await readFile(file, 'utf8'));
  } catch (error) {
    if (!expectedInputFailure(error)) throw error;
    state.isolated.set(file, error.message);
  }
}

function checkAmbiguity(
  state: MigrationPlanningState,
  target: MigrationTarget,
): void {
  try {
    assertUnambiguousMigrationText(target.originalContent);
  } catch (error) {
    state.blockedTargets.add(target.configPath);
    state.incomplete = true;
    state.records.push({
      configPath: target.configPath,
      kind: 'ambiguous-input',
      message: formatErrorMessage(error),
    });
  }
}

function register(
  state: MigrationPlanningState,
  target: MigrationTarget,
): void {
  validateUserMaintainedLiminaTsconfigMetadata({
    ...target,
    rootDir: state.config.rootDir,
  });
  state.targets.set(target.configPath, target);
  state.objects.set(
    target.configPath,
    migrateTsconfigObject({
      ...target,
      isLiminaSolution: target.isTypeScriptSolution,
      rootDir: state.config.rootDir,
    }),
  );
  state.records.push({
    configPath: target.configPath,
    kind: 'parsed',
    original: target.configObject,
    message: target.isTypeScriptSolution
      ? 'solution; compiler options retained'
      : 'source; compiler options retained',
  });
  checkAmbiguity(state, target);
}

async function parseTarget(
  state: MigrationPlanningState,
  file: string,
): Promise<void> {
  try {
    register(
      state,
      await readMigrationTarget({
        config: state.config,
        configPath: file,
        planningVirtualFiles: state.snapshot,
      }),
    );
  } catch (error) {
    if (!expectedInputFailure(error)) throw error;
    state.isolated.set(file, error.message);
  }
}

interface DeclarationInventory {
  state: MigrationPlanningState;
  validTargets: Set<string>;
  activatedPackageRoots: readonly string[];
}

function preserveFailedSolution(
  state: MigrationPlanningState,
  file: string,
  error: Error,
): void {
  state.incomplete = true;
  state.records.push({
    configPath: file,
    kind: 'unresolved-solution-declaration',
    original: state.targets.get(file)!.configObject,
    message: error.message,
  });
}

function isolateDeclaration(
  options: DeclarationInventory,
  file: string,
  error: Error,
): void {
  if (options.state.targets.get(file)!.isTypeScriptSolution) {
    preserveFailedSolution(options.state, file, error);
    return;
  }
  options.state.isolated.set(file, error.message);
  options.state.objects.delete(file);
  options.validTargets.delete(file);
}

function outputProblemMessage(problem: {
  reason?: string;
  title: string;
}): string {
  return problem.reason ?? problem.title;
}

async function validateExistingOutput(
  options: DeclarationInventory,
  file: string,
): Promise<void> {
  const config = planningView(options.state);
  const read = readOutputOptions(
    config,
    file,
    options.state.objects.get(file)!,
  );
  if (!read.outputs) return;
  const problem = await validateOutputRoot({
    config,
    activatedPackageRoots: options.activatedPackageRoots,
    declaredAt: file,
    outputRoot: read.outputs.outDir,
  });
  if (problem) throw new MigrationInputError(outputProblemMessage(problem));
}

function normalize(options: DeclarationInventory, file: string): void {
  normalizeDeclarations({
    config: planningView(options.state),
    configPath: file,
    object: options.state.objects.get(file)!,
    validTargets: options.validTargets,
    records: options.state.records,
  });
}

async function normalizeTarget(
  options: DeclarationInventory,
  file: string,
): Promise<void> {
  try {
    normalize(options, file);
    await validateExistingOutput(options, file);
  } catch (error) {
    if (!expectedInputFailure(error)) throw error;
    isolateDeclaration(options, file, error);
  }
}

async function inventoryDeclarations(
  state: MigrationPlanningState,
): Promise<void> {
  const workspace = await collectWorkspaceInputSnapshot({
    config: state.config,
    rawPackages: await collectRawWorkspacePackages(state.config),
  });
  const validTargets = new Set(
    [...state.targets.values()]
      .filter((target) => !target.isTypeScriptSolution)
      .map((target) => target.configPath),
  );
  const options = {
    state,
    validTargets,
    activatedPackageRoots: workspace.activatedPackageRoots,
  };
  for (const file of state.objects.keys()) await normalizeTarget(options, file);
  const sourceFiles = [...state.objects.keys()].filter(
    (file) => !state.targets.get(file)!.isTypeScriptSolution,
  );
  // All failures are known before pruning remaining incoming declarations.
  for (const file of sourceFiles) normalize(options, file);
}

export async function inventory(state: MigrationPlanningState): Promise<void> {
  state.snapshot.set(
    state.config.configPath,
    await readFile(state.config.configPath, 'utf8'),
  );
  // Capture every candidate before interpreting any candidate.
  for (const file of state.paths) await capture(state, file);
  const readable = state.paths.filter((file) => !state.isolated.has(file));
  for (const file of readable) await parseTarget(state, file);
  await inventoryDeclarations(state);
}

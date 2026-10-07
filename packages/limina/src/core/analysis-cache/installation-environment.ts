import { normalizeAbsolutePath } from '#utils/path';
import type { SupportedPackageManager } from '#utils/workspace-root';
import { realpathSync } from 'node:fs';
import path from 'pathe';
import ts from 'typescript';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { AnalysisInputDriftError, type InputDependency } from './contracts';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { observeInstallationDomain } from './installation-domain';

export interface InstallationDomain {
  adapter: 'physical-installation-v1';
  root: string;
  resolutionRoot: string;
  managerIdentity: string;
  manager: SupportedPackageManager;
  locks: string[];
  dependencies: InputDependency[];
}
export interface TypeEnvironmentRecord {
  policy: 'lockfile-and-local-roots-v1';
  effectiveTypeRoots: string[];
  typeRootsHash: string;
  domains: InstallationDomain[];
  dependencies: InputDependency[];
  evidence: 'observed' | 'lockfile-trusted' | 'unknown';
  reason?: string;
}
export function installationRoot(file: string): string | undefined {
  const canonical = normalizeAbsolutePath(realpathSync.native(file));
  const index = canonical.search(/\/node_modules(?:\/|$)/);
  return index === -1
    ? undefined
    : normalizeAbsolutePath(canonical.slice(0, index + 1));
}
interface EnvironmentObservation {
  dependencies: InputDependency[];
  local: [string, string][];
  installs: Set<string>;
}
function observeRoot(
  file: string,
  inputs: AnalysisInputs,
  observation: EnvironmentObservation,
): void {
  observation.dependencies.push(
    inputs.observe(file, 'directory'),
    inputs.observe(file, 'binding'),
  );
  const install = rootInstallation(file);
  if (install !== undefined) {
    observation.installs.add(install);
    return;
  }
  observeLocalRoot(file, inputs, observation);
}
function rootInstallation(file: string): string | undefined {
  return inputStat(file) === undefined ? undefined : installationRoot(file);
}
function isLocalRoot(file: string): boolean {
  return [
    !file.split('/').includes('node_modules'),
    inputStat(file) !== undefined,
  ].some(Boolean);
}
function installedTargets(inputs: AnalysisInputs, inputId: string): string[] {
  return inputs.records[inputId].installedTargets ?? [];
}
function observeLocalRoot(
  file: string,
  inputs: AnalysisInputs,
  observation: EnvironmentObservation,
): void {
  if (!isLocalRoot(file)) return;
  const tree = inputs.observe(file, 'tree');
  observation.local.push([file, tree.expectedVersion]);
  observation.dependencies.push(tree);
  const targets = installedTargets(inputs, tree.inputId);
  for (const target of targets) addMemberInstallation(target, observation);
}
function addMemberInstallation(
  file: string,
  observation: EnvironmentObservation,
): void {
  if (inputStat(file) === undefined) return;
  const install = installationRoot(file);
  if (install !== undefined) observation.installs.add(install);
}
function addLibraryInstallation(
  project: TypeScriptSemanticProject,
  observation: EnvironmentObservation,
): void {
  if (project.options.noLib) return;
  const library = ts.getDefaultLibFilePath(project.options);
  observation.installs.add(installationRoot(library) ?? path.dirname(library));
}
function observeDomains(
  project: TypeScriptSemanticProject,
  inputs: AnalysisInputs,
  roots: Set<string>,
): { domains: InstallationDomain[]; reason?: string } {
  const domains: InstallationDomain[] = [];
  let reason: string | undefined;
  for (const root of roots) {
    try {
      domains.push(
        inputs.memoizeObservation(
          `installation:${root}:${project.configPath}`,
          () =>
            observeInstallationDomain({
              root,
              configPath: project.configPath,
              inputs,
            }),
        ),
      );
    } catch (error) {
      reason = environmentFailure(error);
    }
  }
  return { domains, reason };
}
function environmentFailure(error: unknown): string {
  if (error instanceof AnalysisInputDriftError) throw error;
  return String(error);
}
function evidence(
  domains: InstallationDomain[],
  reason: string | undefined,
): TypeEnvironmentRecord['evidence'] {
  if (reason !== undefined) return 'unknown';
  return domains.length === 0 ? 'observed' : 'lockfile-trusted';
}
function effectiveRoots(project: TypeScriptSemanticProject): string[] {
  return (
    ts.getEffectiveTypeRoots(project.options, {
      getCurrentDirectory: () => path.dirname(project.configPath),
    }) ?? []
  );
}
function rootsPresence(project: TypeScriptSemanticProject): string {
  return project.options.typeRoots === undefined ? 'default' : 'explicit';
}
function unknownReason(reason: string | undefined): { reason?: string } {
  return reason === undefined ? {} : { reason };
}
function environmentRecord(
  options: {
    project: TypeScriptSemanticProject;
    roots: string[];
    observation: EnvironmentObservation;
  },
  result: { domains: InstallationDomain[]; reason?: string },
): TypeEnvironmentRecord {
  const { project, roots, observation } = options;
  const { domains, reason } = result;
  const dependencies = [
    ...observation.dependencies,
    ...domains.flatMap((item) => item.dependencies),
  ];
  return {
    policy: 'lockfile-and-local-roots-v1',
    effectiveTypeRoots: roots,
    typeRootsHash: analysisHash([
      rootsPresence(project),
      roots,
      observation.local,
    ]),
    domains,
    dependencies,
    evidence: evidence(domains, reason),
    ...unknownReason(reason),
  };
}
function observeEnvironmentMembers(options: {
  project: TypeScriptSemanticProject;
  inputs: AnalysisInputs;
  roots: string[];
  members: readonly string[];
  observation: EnvironmentObservation;
}): void {
  const { project, inputs, roots, members, observation } = options;
  for (const root of roots)
    observeRoot(normalizeAbsolutePath(root), inputs, observation);
  for (const member of members) addMemberInstallation(member, observation);
  addLibraryInstallation(project, observation);
}
export function observeTypeEnvironment(
  project: TypeScriptSemanticProject,
  inputs: AnalysisInputs,
  members: readonly string[] = [],
): TypeEnvironmentRecord {
  const roots = effectiveRoots(project);
  const observation: EnvironmentObservation = {
    dependencies: [],
    local: [],
    installs: new Set(),
  };
  observeEnvironmentMembers({ project, inputs, roots, members, observation });
  const result = observeDomains(project, inputs, observation.installs);
  return environmentRecord({ project, roots, observation }, result);
}

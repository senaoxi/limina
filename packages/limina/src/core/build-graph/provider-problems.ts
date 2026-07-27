import type { ResolvedLiminaConfig } from '#config/runner';
import type { collectImportsFromFile } from '#core/import-graph/context';
import { formatImportRecordLocation } from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import {
  getSourceProjectBuildEngine,
  getSourceProjectPreset,
} from './project-indexes';
import { formatProviderCandidateLines } from './provider-selection';
import type { SourceProject } from './types';

type ImportRecord = ReturnType<typeof collectImportsFromFile>[number];

export function formatMissingCrossCheckerProviderProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
  targetProjects: SourceProject[];
  targetSourceConfigPath: string;
}): string {
  return [
    'Unable to resolve cross-checker declaration provider:',
    `  from checker: ${options.project.checkerName}`,
    `  from config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  candidate checker: ${options.targetProjects.map((project) => project.checkerName).join(', ')}`,
    `  target config: ${toRelativePath(options.config.rootDir, options.targetSourceConfigPath)}`,
    '  reason: cross-checker imports need a build-capable checker that owns the resolved file.',
    '  fix: cover the target source config with a build-capable checker preset such as tsc, tsgo, or vue-tsc.',
  ].join('\n');
}

export function formatAmbiguousCrossCheckerProviderProblem(options: {
  candidates: SourceProject[];
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
  targetSourceConfigPath: string;
}): string {
  return [
    'Ambiguous cross-checker declaration provider:',
    `  consumer checker: ${options.project.checkerName} (${getSourceProjectPreset(options.project)})`,
    `  consumer config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  target config: ${toRelativePath(options.config.rootDir, options.targetSourceConfigPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    '  candidates:',
    ...formatProviderCandidateLines(options.candidates),
    '  reason: multiple build-capable provider checkers can own the resolved file, and Limina cannot choose a stable generated declaration provider.',
    '  fix: make checker ownership unambiguous with config.checkers.<checker>.include/exclude.',
  ].join('\n');
}

export function formatUnsafeCrossEngineProviderProblem(options: {
  candidates: SourceProject[];
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
  targetSourceConfigPath: string;
}): string {
  return [
    'Unsafe cross-engine declaration provider:',
    `  consumer checker: ${options.project.checkerName} (${getSourceProjectPreset(options.project)}, engine: ${getSourceProjectBuildEngine(options.project)})`,
    `  consumer config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  target config: ${toRelativePath(options.config.rootDir, options.targetSourceConfigPath)}`,
    '  provider candidates:',
    ...formatProviderCandidateLines(options.candidates),
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    '  reason: generated project references must not cross checker build-engine boundaries in V1 because they can make generated graph and cache ownership unstable.',
    '  fix: make the target config owned by the consumer checker, choose one build checker owner, or split the dependency through an explicit declaration/artifact boundary.',
  ].join('\n');
}

export function formatOxcOnlyDeclarationProviderProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  oxcResolvedFilePath: string;
  project: SourceProject;
}): string {
  return [
    'Oxc can resolve this specifier, but TypeScript cannot:',
    `  importing config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  Oxc resolved file: ${toRelativePath(options.config.rootDir, options.oxcResolvedFilePath)}`,
    '  reason: generated declaration references follow the checker-aware TypeScript declaration provider, not the Oxc runtime-like resolver.',
    '  fix: check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
  ].join('\n');
}

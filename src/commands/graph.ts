import type { ResolvedLiminaConfig } from '#config/runner';
import type { DependencyGraphDocument } from '../dependency-graph/runner';
import {
  type RunGraphCheckOptions,
  runGraphExportImpl,
  type RunGraphExportOptions,
  type RunGraphPrepareOptions,
} from '../graph-check/runner';
import {
  createGraphCheckCommandContext,
  executeGraphCheckCommand,
  handleGraphCheckCommandError,
} from './graph-check-command';
import {
  createGraphPrepareCommandContext,
  executeGraphPrepareCommand,
  handleGraphPrepareCommandError,
} from './graph-prepare-command';

export type {
  RunGraphCheckOptions,
  RunGraphExportOptions,
  RunGraphPrepareOptions,
} from '../graph-check/runner';

export async function runGraphPrepare(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<boolean> {
  const context = createGraphPrepareCommandContext(config, options);

  try {
    return await executeGraphPrepareCommand(context);
  } catch (error) {
    return handleGraphPrepareCommandError(context, error);
  }
}

export async function runGraphCheck(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions = {},
): Promise<boolean> {
  const context = createGraphCheckCommandContext(config, options);

  try {
    return await executeGraphCheckCommand(context);
  } catch (error) {
    return handleGraphCheckCommandError(context, error);
  }
}

export async function runGraphExport(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  return runGraphExportImpl(config, options);
}

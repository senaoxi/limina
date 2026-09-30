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
  isExecuteGraphCheckCommand,
  isHandleGraphCheckCommandError,
} from './graph-check-command';
import {
  createGraphPrepareCommandContext,
  handleGraphPrepareCommandError,
  isExecuteGraphPrepareCommand,
} from './graph-prepare-command';

export type {
  RunGraphCheckOptions,
  RunGraphExportOptions,
  RunGraphPrepareOptions,
} from '../graph-check/runner';

export async function isRunGraphPrepare(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<boolean> {
  const context = createGraphPrepareCommandContext(config, options);

  try {
    return await isExecuteGraphPrepareCommand(context);
  } catch (error) {
    return handleGraphPrepareCommandError(context, error);
  }
}

export async function isRunGraphCheck(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions = {},
): Promise<boolean> {
  const context = createGraphCheckCommandContext(config, options);

  try {
    return await isExecuteGraphCheckCommand(context);
  } catch (error) {
    return isHandleGraphCheckCommandError(context, error);
  }
}

export async function runGraphExport(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  return runGraphExportImpl(config, options);
}

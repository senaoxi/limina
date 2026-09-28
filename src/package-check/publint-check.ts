import type { PackagePublintCheckConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import {
  formatMissingOptionalToolSkipMessage,
  isLiminaOptionalToolMissingError,
} from '../execution/tools';
import type { LiminaFlowReporter } from '../flow';
import { PackageLogger } from '../logger';
import { addPackageCheckIssue } from './issue';
import { loadPublintPeer } from './peer-tools';
import type { PackageToolCheckResult } from './runner-types';

interface PublintCheckOptions {
  config: PackagePublintCheckConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  packageManifestPath: string;
  packageName?: string;
  rootDir: string;
  tarball: Buffer;
}

type PublintPeer = Awaited<ReturnType<typeof loadPublintPeer>>;
type PublintTask = ReturnType<NonNullable<LiminaFlowReporter['start']>>;
type PublintResult = Awaited<ReturnType<PublintPeer['publint']>>;

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function createTask(options: PublintCheckOptions): PublintTask | undefined {
  if (options.flow === undefined) return undefined;
  return options.flow.start(`publint: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
}

function requireOptionalToolError(error: unknown) {
  if (!isLiminaOptionalToolMissingError(error)) throw error;
  return error;
}

function skipMissingPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  error: unknown;
  label: string;
  task: PublintTask | undefined;
}): null {
  const optionalError = requireOptionalToolError(options.error);
  const message = formatMissingOptionalToolSkipMessage(optionalError.toolName);
  PackageLogger.warn(`${message}: ${options.label}`, options.elapsed());
  if (options.task !== undefined) options.task.skip(message);
  return null;
}

async function resolvePublintPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: PublintTask | undefined;
}): Promise<PublintPeer | null> {
  try {
    return await loadPublintPeer();
  } catch (error) {
    return skipMissingPeer({ ...options, error });
  }
}

function addPublintIssue(options: {
  checkOptions: PublintCheckOptions;
  code: string;
  rendered: string;
}): void {
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_PUBLINT',
    detailLines: [
      `[${options.checkOptions.label}] [publint] ${options.rendered}`,
    ],
    evidence: [{ label: 'publint', value: options.rendered }],
    external: {
      code: options.code,
      message: options.rendered,
      tool: 'publint',
    },
    fix: 'Inspect the publint message and adjust package exports, types, or published files.',
    fixSteps: [
      'Inspect the publint message for the affected export, type, or published file.',
      'Update the built package manifest or package output so publint resolves the package correctly.',
      'Rebuild the package output and rerun the package check.',
    ],
    issueSink: options.checkOptions.issueSink,
    packageManifestPath: options.checkOptions.packageManifestPath,
    packageName: options.checkOptions.packageName,
    reason: options.rendered,
    rootDir: options.checkOptions.rootDir,
    summary: options.rendered,
    title: 'Publint package issue',
    tool: 'publint',
  });
}

function getPublintLogger(type: string): (value: string) => void {
  const loggerByType: Record<string, (value: string) => void> = {
    error: (value) => PackageLogger.error(value),
    warning: (value) => PackageLogger.warn(value),
  };
  const logger = loggerByType[type];
  if (logger !== undefined) return logger;
  return (value) => PackageLogger.info(value);
}

function logPublintMessage(options: {
  label: string;
  rendered: string;
  type: string;
}): void {
  getPublintLogger(options.type)(
    `[${options.label}] [publint] ${options.rendered}`,
  );
}

function renderPublintMessage(options: {
  formatMessage: PublintPeer['formatMessage'];
  message: PublintResult['messages'][number];
  pkg: PublintResult['pkg'];
}): string {
  const rendered = options.formatMessage(options.message, options.pkg);
  return rendered === undefined ? options.message.code : rendered;
}

function reportPublintMessages(options: {
  checkOptions: PublintCheckOptions;
  formatMessage: PublintPeer['formatMessage'];
  result: PublintResult;
}): void {
  for (const message of options.result.messages) {
    const rendered = renderPublintMessage({
      formatMessage: options.formatMessage,
      message,
      pkg: options.result.pkg,
    });
    addPublintIssue({
      checkOptions: options.checkOptions,
      code: message.code,
      rendered,
    });
    logPublintMessage({
      label: options.checkOptions.label,
      rendered,
      type: message.type,
    });
  }
}

function passTask(task: PublintTask | undefined): void {
  if (task !== undefined) task.pass();
}

function failTask(task: PublintTask | undefined, message: string): void {
  if (task !== undefined) task.fail(message);
}

function finishPassedPublint(options: {
  checkOptions: PublintCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  task: PublintTask | undefined;
}): PackageToolCheckResult {
  if (options.checkOptions.flow?.interactive !== true) {
    PackageLogger.success(
      `publint passed: ${options.checkOptions.label}`,
      options.elapsed(),
    );
  }
  passTask(options.task);
  return 'passed';
}

function finishFailedPublint(options: {
  count: number;
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: PublintTask | undefined;
}): PackageToolCheckResult {
  const message = `publint found ${options.count} issue(s): ${options.label}`;
  PackageLogger.error(message, options.elapsed());
  failTask(options.task, message);
  return 'failed';
}

function getStrictSetting(config: PackagePublintCheckConfig): boolean {
  return config.strict === undefined ? true : config.strict;
}

async function executePublint(options: {
  checkOptions: PublintCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  peer: PublintPeer;
  task: PublintTask | undefined;
}): Promise<PackageToolCheckResult> {
  const result = await options.peer.publint({
    level: options.checkOptions.config.level,
    pack: { tarball: toArrayBuffer(options.checkOptions.tarball) },
    strict: getStrictSetting(options.checkOptions.config),
  });
  if (result.messages.length === 0) {
    return finishPassedPublint(options);
  }
  reportPublintMessages({
    checkOptions: options.checkOptions,
    formatMessage: options.peer.formatMessage,
    result,
  });
  return finishFailedPublint({
    count: result.messages.length,
    elapsed: options.elapsed,
    label: options.checkOptions.label,
    task: options.task,
  });
}

export async function runPublintCheck(
  options: PublintCheckOptions,
): Promise<PackageToolCheckResult> {
  const task = createTask(options);
  const elapsed = createElapsedTimer();
  const peer = await resolvePublintPeer({
    elapsed,
    label: options.label,
    task,
  });
  if (peer === null) return 'skipped';
  PackageLogger.info(`publint started: ${options.label}`);
  return executePublint({ checkOptions: options, elapsed, peer, task });
}

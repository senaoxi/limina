import { isPlainRecord } from '#utils/values';
import { formatErrorMessage } from '../../../logger';
import {
  resolveReleaseRegistryMetadataUrl,
  resolveReleaseRegistryTimeoutMs,
} from '../../release-registry-test-seam';
import type {
  RegistryMetadataResult,
  RegistryPackageMetadata,
  RegistryVersionMetadata,
  ReleaseConsistencyState,
} from '../consistency/types';

const REGISTRY_METADATA_TIMEOUT_MS = 30_000;

interface RegistryMetadataResponse {
  response: Response;
  signal: AbortSignal;
  timeoutMs: number;
  url: string;
}

function cacheMetadataResult(options: {
  packageName: string;
  result: RegistryMetadataResult;
  state: ReleaseConsistencyState;
}): RegistryMetadataResult {
  options.state.registryMetadataCache.set(options.packageName, options.result);
  return options.result;
}

function createMetadataRequestFailure(options: {
  error: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  url: string;
}): RegistryMetadataResult {
  if (options.signal.aborted) {
    return {
      cause: options.error,
      kind: 'failure',
      reason: 'timeout',
      timeoutMs: options.timeoutMs,
      url: options.url,
    };
  }
  return {
    cause: options.error,
    kind: 'failure',
    reason: 'request',
    url: options.url,
  };
}

async function requestRegistryMetadata(
  packageName: string,
): Promise<RegistryMetadataResponse | RegistryMetadataResult> {
  const url = resolveReleaseRegistryMetadataUrl(packageName);
  const timeoutMs = resolveReleaseRegistryTimeoutMs(
    REGISTRY_METADATA_TIMEOUT_MS,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal,
    });
    return { response, signal, timeoutMs, url };
  } catch (error) {
    return createMetadataRequestFailure({ error, signal, timeoutMs, url });
  }
}

function isMetadataResponse(
  value: RegistryMetadataResponse | RegistryMetadataResult,
): value is RegistryMetadataResponse {
  return 'response' in value;
}

function getMetadataResponseProblem(
  request: RegistryMetadataResponse,
): RegistryMetadataResult | null {
  if (request.response.status === 404) {
    return { kind: 'missing', statusCode: 404, url: request.url };
  }
  if (request.response.ok) return null;
  return {
    kind: 'failure',
    reason: 'http-status',
    statusCode: request.response.status,
    statusText: request.response.statusText,
    url: request.url,
  };
}

function getMetadataBodyFailureReason(options: {
  error: unknown;
  signal: AbortSignal;
}): 'body-read' | 'invalid-json' | 'timeout' {
  if (options.signal.aborted) return 'timeout';
  if (options.error instanceof SyntaxError) return 'invalid-json';
  return 'body-read';
}

function getMetadataBodyFailure(options: {
  error: unknown;
  request: RegistryMetadataResponse;
}): RegistryMetadataResult {
  const reason = getMetadataBodyFailureReason({
    error: options.error,
    signal: options.request.signal,
  });
  return {
    cause: options.error,
    kind: 'failure',
    reason,
    statusCode: options.request.response.status,
    statusText: options.request.response.statusText,
    timeoutMs: reason === 'timeout' ? options.request.timeoutMs : undefined,
    url: options.request.url,
  };
}

function createInvalidMetadataResult(
  request: RegistryMetadataResponse,
): RegistryMetadataResult {
  return {
    cause: new TypeError('registry metadata response must be a JSON object'),
    kind: 'failure',
    reason: 'invalid-metadata',
    statusCode: request.response.status,
    statusText: request.response.statusText,
    url: request.url,
  };
}

async function parseMetadataResponse(
  request: RegistryMetadataResponse,
): Promise<RegistryMetadataResult> {
  let metadata: unknown;
  try {
    metadata = await request.response.json();
  } catch (error) {
    return getMetadataBodyFailure({ error, request });
  }
  if (!isPlainRecord(metadata)) return createInvalidMetadataResult(request);
  return { kind: 'found', metadata: metadata as RegistryPackageMetadata };
}

async function loadRegistryPackageMetadata(
  packageName: string,
): Promise<RegistryMetadataResult> {
  const request = await requestRegistryMetadata(packageName);
  if (!isMetadataResponse(request)) return request;
  const responseProblem = getMetadataResponseProblem(request);
  if (responseProblem !== null) return responseProblem;
  return parseMetadataResponse(request);
}

export async function fetchRegistryPackageMetadata(
  packageName: string,
  state: ReleaseConsistencyState,
): Promise<RegistryMetadataResult> {
  const cached = state.registryMetadataCache.get(packageName);
  if (cached !== undefined) return cached;
  const result = await loadRegistryPackageMetadata(packageName);
  return cacheMetadataResult({ packageName, result, state });
}

function formatMetadataTimeout(
  packageName: string,
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  const timeoutMs = failure.timeoutMs ?? REGISTRY_METADATA_TIMEOUT_MS;
  const duration =
    timeoutMs === REGISTRY_METADATA_TIMEOUT_MS
      ? '30 seconds'
      : `${String(timeoutMs)} milliseconds`;
  return `npm registry metadata request for ${packageName} from ${failure.url} timed out after ${duration}`;
}

function formatMetadataStatus(
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  if (failure.statusCode === undefined) return '';
  const text = failure.statusText ? ` ${failure.statusText}` : '';
  return ` (${failure.statusCode}${text})`;
}

function formatMetadataCause(
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  if (failure.cause === undefined) return '';
  return `: ${formatErrorMessage(failure.cause)}`;
}

const METADATA_FAILURE_PREFIXES = {
  'body-read': 'unable to read npm registry metadata response body for',
  'invalid-json': 'npm registry metadata response for',
  'invalid-metadata': 'invalid npm registry metadata response for',
} as const;

function formatKnownMetadataFailure(options: {
  cause: string;
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>;
  packageName: string;
}): string | null {
  const prefix =
    METADATA_FAILURE_PREFIXES[
      options.failure.reason as keyof typeof METADATA_FAILURE_PREFIXES
    ];
  if (prefix === undefined) return null;
  if (options.failure.reason === 'invalid-json') {
    return `${prefix} ${options.packageName} from ${options.failure.url} is not valid JSON${options.cause}`;
  }
  return `${prefix} ${options.packageName} from ${options.failure.url}${options.cause}`;
}

export function formatRegistryMetadataFailure(
  packageName: string,
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  if (failure.reason === 'timeout') {
    return formatMetadataTimeout(packageName, failure);
  }
  const cause = formatMetadataCause(failure);
  const known = formatKnownMetadataFailure({ cause, failure, packageName });
  if (known !== null) return known;
  return `unable to read npm registry metadata for ${packageName} from ${failure.url}${formatMetadataStatus(failure)}${cause}`;
}

export function findRegistryVersionMetadata(
  metadata: RegistryPackageMetadata,
  version: string,
): RegistryVersionMetadata | null {
  if (!isPlainRecord(metadata.versions)) return null;
  const versionMetadata = metadata.versions[version];
  if (!isPlainRecord(versionMetadata)) return null;
  return versionMetadata as RegistryVersionMetadata;
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

export function findRegistryDistTagVersion(
  metadata: RegistryPackageMetadata,
  distTag: string,
): string | null {
  if (!isPlainRecord(metadata['dist-tags'])) return null;
  return getNonEmptyString(metadata['dist-tags'][distTag]);
}

export function getRegistryTarballUrl(
  versionMetadata: RegistryVersionMetadata,
): string | null {
  if (!isPlainRecord(versionMetadata.dist)) return null;
  return getNonEmptyString(versionMetadata.dist.tarball);
}

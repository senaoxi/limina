import { isPlainRecord } from '#utils/values';
import { formatErrorMessage } from '../../../logger';
import type {
  RegistryMetadataResult,
  RegistryPackageMetadata,
  RegistryVersionMetadata,
  ReleaseConsistencyState,
} from '../consistency/types';
import {
  type EffectiveRegistryAuthority,
  resolveReleaseRegistryMetadataUrl,
} from './authority';
import {
  cancelRegistryBody,
  readRegistryBody,
  REGISTRY_METADATA_MAX_BYTES,
  RegistryBodyLimitError,
} from './body';

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
  authority: EffectiveRegistryAuthority,
): Promise<RegistryMetadataResponse | RegistryMetadataResult> {
  const url = resolveReleaseRegistryMetadataUrl(packageName, authority);
  const timeoutMs = authority.timeoutMs ?? REGISTRY_METADATA_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'error',
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
  return options.error instanceof SyntaxError ? 'invalid-json' : 'body-read';
}

function getMetadataBodyFailure(options: {
  error: unknown;
  request: RegistryMetadataResponse;
}): RegistryMetadataResult {
  if (options.error instanceof RegistryBodyLimitError) {
    return {
      kind: 'failure',
      reason: 'body-too-large',
      url: options.request.url,
      maxBytes: options.error.maxBytes,
      receivedBytes: options.error.receivedBytes,
    };
  }
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
    const body = await readRegistryBody(
      request.response,
      REGISTRY_METADATA_MAX_BYTES,
    );
    metadata = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    return getMetadataBodyFailure({ error, request });
  }
  return isPlainRecord(metadata)
    ? { kind: 'found', metadata: metadata as RegistryPackageMetadata }
    : createInvalidMetadataResult(request);
}

async function loadRegistryPackageMetadata(
  packageName: string,
  authority: EffectiveRegistryAuthority,
): Promise<RegistryMetadataResult> {
  const request = await requestRegistryMetadata(packageName, authority);
  if (!isMetadataResponse(request)) return request;
  const responseProblem = getMetadataResponseProblem(request);
  if (responseProblem !== null) {
    await cancelRegistryBody(request.response);
    return responseProblem;
  }
  return parseMetadataResponse(request);
}

export async function fetchRegistryPackageMetadata(
  packageName: string,
  state: ReleaseConsistencyState,
  authority: EffectiveRegistryAuthority,
): Promise<RegistryMetadataResult> {
  const cacheKey = JSON.stringify([authority.baseUrl, packageName]);
  const cached = state.registryMetadataCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = await loadRegistryPackageMetadata(packageName, authority);
  return cacheMetadataResult({ packageName: cacheKey, result, state });
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
  return failure.cause === undefined
    ? ''
    : `: ${formatErrorMessage(failure.cause)}`;
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
  return options.failure.reason === 'invalid-json'
    ? `${prefix} ${options.packageName} from ${options.failure.url} is not valid JSON${options.cause}`
    : `${prefix} ${options.packageName} from ${options.failure.url}${options.cause}`;
}

export function formatRegistryMetadataFailure(
  packageName: string,
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  if (failure.reason === 'body-too-large')
    return `npm registry metadata for ${packageName} exceeds the ${failure.maxBytes} byte limit`;
  return failure.reason === 'timeout'
    ? formatMetadataTimeout(packageName, failure)
    : formatOtherMetadataFailure(packageName, failure);
}

function formatOtherMetadataFailure(
  packageName: string,
  failure: Extract<RegistryMetadataResult, { kind: 'failure' }>,
): string {
  const cause = formatMetadataCause(failure);
  const known = formatKnownMetadataFailure({ cause, failure, packageName });
  return known === null
    ? `unable to read npm registry metadata for ${packageName} from ${failure.url}${formatMetadataStatus(failure)}${cause}`
    : known;
}

export function findRegistryVersionMetadata(
  metadata: RegistryPackageMetadata,
  version: string,
): RegistryVersionMetadata | null {
  if (!isPlainRecord(metadata.versions)) return null;
  const versionMetadata = metadata.versions[version];
  return isPlainRecord(versionMetadata)
    ? (versionMetadata as RegistryVersionMetadata)
    : null;
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

export function findRegistryDistributionTagVersion(
  metadata: RegistryPackageMetadata,
  distributionTag: string,
): string | null {
  return isPlainRecord(metadata['dist-tags'])
    ? getNonEmptyString(metadata['dist-tags'][distributionTag])
    : null;
}

export function getRegistryTarballUrl(
  versionMetadata: RegistryVersionMetadata,
): string | null {
  return isPlainRecord(versionMetadata.dist)
    ? getNonEmptyString(versionMetadata.dist.tarball)
    : null;
}

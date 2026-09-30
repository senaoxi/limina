import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import ssri from 'ssri';
import { formatErrorMessage } from '../../../logger';
import type {
  RegistryTarballIntegrityResult,
  RegistryVersionMetadata,
} from '../consistency/types';
import { RegistryTarballError } from '../consistency/types';
import type { EffectiveRegistryAuthority } from './authority';
import {
  cancelRegistryBody,
  readRegistryBody,
  REGISTRY_TARBALL_MAX_BYTES,
  RegistryBodyLimitError,
} from './body';
import { resolveRegistryTarballUrl } from './tarball-url';

const REGISTRY_TARBALL_TIMEOUT_MS = 120_000;

function isValidIntegrityToken(token: string): boolean {
  try {
    const parsed = ssri.parse(token, { strict: true });
    return parsed !== null && parsed.toString({ strict: true }) === token;
  } catch {
    return false;
  }
}

function parseRegistryTarballIntegrity(value: string): string | null {
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.every(isValidIntegrityToken) ? tokens.join(' ') : null;
}

function resolveIntegrityField(options: {
  integrityValue: unknown;
  shasumValue: unknown;
}): RegistryTarballIntegrityResult {
  const integrity =
    typeof options.integrityValue === 'string'
      ? parseRegistryTarballIntegrity(options.integrityValue)
      : null;
  if (integrity !== null) {
    return {
      integrity,
      kind: 'found',
      registryIntegrity: options.integrityValue,
      registryShasum: options.shasumValue,
      source: 'integrity',
    };
  }
  return {
    field: 'integrity',
    kind: 'invalid',
    registryIntegrity: options.integrityValue,
    registryShasum: options.shasumValue,
  };
}

function isValidShasum(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{40}$/iu.test(value);
}

function createInvalidShasum(
  shasumValue: unknown,
): RegistryTarballIntegrityResult {
  return {
    field: 'shasum',
    kind: 'invalid',
    registryShasum: shasumValue,
  };
}

function createShasumIntegrity(
  shasumValue: string,
): RegistryTarballIntegrityResult {
  const integrity = ssri.fromHex(shasumValue, 'sha1')?.toString();
  if (integrity === undefined) return createInvalidShasum(shasumValue);
  return {
    expectedShasum: shasumValue,
    integrity,
    kind: 'found',
    registryShasum: shasumValue,
    source: 'shasum',
  };
}

function resolveShasumField(
  shasumValue: unknown,
): RegistryTarballIntegrityResult {
  if (shasumValue === undefined) return { kind: 'missing' };
  return isValidShasum(shasumValue)
    ? createShasumIntegrity(shasumValue)
    : createInvalidShasum(shasumValue);
}

export function resolveRegistryTarballIntegrity(
  versionMetadata: RegistryVersionMetadata,
): RegistryTarballIntegrityResult {
  if (!isPlainRecord(versionMetadata.dist)) return { kind: 'missing' };
  const integrityValue = versionMetadata.dist.integrity;
  const shasumValue = versionMetadata.dist.shasum;
  return integrityValue === undefined
    ? resolveShasumField(shasumValue)
    : resolveIntegrityField({ integrityValue, shasumValue });
}

export function verifyRegistryTarballIntegrity(options: {
  expectedShasum?: string;
  integrity: string;
  packageName: string;
  tarball: Buffer;
  tarballUrl: string;
  version: string;
}): void {
  if (ssri.checkData(options.tarball, options.integrity)) return;
  throw new RegistryTarballError(
    {
      actualIntegrity: ssri.fromData(options.tarball)?.toString(),
      actualShasum: createHash('sha1').update(options.tarball).digest('hex'),
      expectedIntegrity: options.integrity,
      expectedShasum: options.expectedShasum,
      kind: 'integrity-mismatch',
      tarballUrl: options.tarballUrl,
    },
    `npm tarball integrity mismatch for ${options.packageName}@${options.version} from ${options.tarballUrl}`,
  );
}

function formatTarballTimeout(timeoutMs: number): string {
  return timeoutMs === REGISTRY_TARBALL_TIMEOUT_MS
    ? '120 seconds'
    : `${String(timeoutMs)} milliseconds`;
}

function createTarballTimeoutError(options: {
  error: unknown;
  tarballUrl: string;
  timeoutMs: number;
}): RegistryTarballError {
  return new RegistryTarballError(
    {
      errorMessage: formatErrorMessage(options.error),
      kind: 'tarball-timeout',
      tarballUrl: options.tarballUrl,
      timeoutMs: options.timeoutMs,
    },
    `npm tarball request for ${options.tarballUrl} timed out after ${formatTarballTimeout(options.timeoutMs)}`,
  );
}

function createTarballRequestError(options: {
  error: unknown;
  tarballUrl: string;
}): RegistryTarballError {
  return new RegistryTarballError(
    {
      errorMessage: formatErrorMessage(options.error),
      kind: 'tarball-request',
      tarballUrl: options.tarballUrl,
    },
    `unable to request npm tarball ${options.tarballUrl}: ${formatErrorMessage(options.error)}`,
  );
}

async function requestRegistryTarball(options: {
  signal: AbortSignal;
  tarballUrl: string;
  timeoutMs: number;
}): Promise<Response> {
  try {
    return await fetch(options.tarballUrl, {
      redirect: 'error',
      headers: { accept: 'application/octet-stream' },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw createTarballTimeoutError({ ...options, error });
    }
    throw createTarballRequestError({ error, tarballUrl: options.tarballUrl });
  }
}

async function assertSuccessfulTarballResponse(
  response: Response,
  tarballUrl: string,
): Promise<void> {
  if (response.ok) return;
  await cancelRegistryBody(response);
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const status = `${response.status}${statusText}`;
  throw new RegistryTarballError(
    {
      kind: 'tarball-http-status',
      statusCode: response.status,
      statusText: response.statusText,
      tarballUrl,
    },
    `unable to download npm tarball ${tarballUrl}: ${status}`,
  );
}

function createTarballBodyError(options: {
  error: unknown;
  tarballUrl: string;
}): RegistryTarballError {
  return new RegistryTarballError(
    {
      errorMessage: formatErrorMessage(options.error),
      kind: 'tarball-body-read',
      tarballUrl: options.tarballUrl,
    },
    `unable to read npm tarball response body for ${options.tarballUrl}: ${formatErrorMessage(options.error)}`,
  );
}

function throwTarballReadFailure(options: {
  error: unknown;
  signal: AbortSignal;
  tarballUrl: string;
  timeoutMs: number;
}): never {
  if (options.signal.aborted) {
    throw createTarballTimeoutError(options);
  }
  throw createTarballBodyError({
    error: options.error,
    tarballUrl: options.tarballUrl,
  });
}

async function readRegistryTarballBody(options: {
  response: Response;
  signal: AbortSignal;
  tarballUrl: string;
  timeoutMs: number;
}): Promise<Buffer> {
  try {
    return await readRegistryBody(options.response, REGISTRY_TARBALL_MAX_BYTES);
  } catch (error) {
    if (error instanceof RegistryBodyLimitError) {
      throw new RegistryTarballError(
        {
          kind: 'tarball-body-too-large',
          tarballUrl: options.tarballUrl,
          maxBytes: error.maxBytes,
          receivedBytes: error.receivedBytes,
        },
        error.message,
      );
    }
    return throwTarballReadFailure({ ...options, error });
  }
}

export async function fetchRegistryTarball(
  value: string,
  authority: EffectiveRegistryAuthority,
): Promise<Buffer> {
  const tarballUrl = resolveRegistryTarballUrl(value, authority);
  const timeoutMs = authority.timeoutMs ?? REGISTRY_TARBALL_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await requestRegistryTarball({
    signal,
    tarballUrl,
    timeoutMs,
  });
  await assertSuccessfulTarballResponse(response, tarballUrl);
  return readRegistryTarballBody({
    response,
    signal,
    tarballUrl,
    timeoutMs,
  });
}

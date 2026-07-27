import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import ssri from 'ssri';
import { formatErrorMessage } from '../../../logger';
import {
  assertReleaseRegistryTarballUrlAllowed,
  resolveReleaseRegistryTimeoutMs,
} from '../../release-registry-test-seam';
import type {
  RegistryTarballIntegrityResult,
  RegistryVersionMetadata,
} from '../consistency/types';
import { RegistryTarballError } from '../consistency/types';

const REGISTRY_TARBALL_TIMEOUT_MS = 120_000;

function isValidIntegrityToken(token: string): boolean {
  try {
    const parsed = ssri.parse(token, { strict: true });
    if (parsed === null) return false;
    return parsed.toString({ strict: true }) === token;
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
  if (typeof value !== 'string') return false;
  return /^[\da-f]{40}$/iu.test(value);
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
  if (!isValidShasum(shasumValue)) return createInvalidShasum(shasumValue);
  return createShasumIntegrity(shasumValue);
}

export function resolveRegistryTarballIntegrity(
  versionMetadata: RegistryVersionMetadata,
): RegistryTarballIntegrityResult {
  if (!isPlainRecord(versionMetadata.dist)) return { kind: 'missing' };
  const integrityValue = versionMetadata.dist.integrity;
  const shasumValue = versionMetadata.dist.shasum;
  if (integrityValue !== undefined) {
    return resolveIntegrityField({ integrityValue, shasumValue });
  }
  return resolveShasumField(shasumValue);
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
  if (timeoutMs === REGISTRY_TARBALL_TIMEOUT_MS) return '120 seconds';
  return `${String(timeoutMs)} milliseconds`;
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

function assertSuccessfulTarballResponse(
  response: Response,
  tarballUrl: string,
): void {
  if (response.ok) return;
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

async function readRegistryTarballBody(options: {
  response: Response;
  signal: AbortSignal;
  tarballUrl: string;
  timeoutMs: number;
}): Promise<Buffer> {
  try {
    return Buffer.from(await options.response.arrayBuffer());
  } catch (error) {
    if (options.signal.aborted) {
      throw createTarballTimeoutError({ ...options, error });
    }
    throw createTarballBodyError({ error, tarballUrl: options.tarballUrl });
  }
}

export async function fetchRegistryTarball(
  tarballUrl: string,
): Promise<Buffer> {
  assertReleaseRegistryTarballUrlAllowed(tarballUrl);
  const timeoutMs = resolveReleaseRegistryTimeoutMs(
    REGISTRY_TARBALL_TIMEOUT_MS,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await requestRegistryTarball({
    signal,
    tarballUrl,
    timeoutMs,
  });
  assertSuccessfulTarballResponse(response, tarballUrl);
  return readRegistryTarballBody({
    response,
    signal,
    tarballUrl,
    timeoutMs,
  });
}

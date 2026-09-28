import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type {
  ExpectedRegistryRequest,
  LocalRegistryDigestDeclaration,
  LocalRegistryResponse,
  LocalRegistryResponseBody,
  LocalRegistryScenario,
} from './detector-fixture-types';
import {
  createDeterministicPackageTarball,
  type DeterministicPackageTarball,
} from './deterministic-tarball';

const SAFE_RECORDED_HEADER_NAMES = ['accept', 'host', 'user-agent'] as const;

interface PreparedBytesBody {
  readonly bytes: Buffer;
  readonly kind: 'prepared-bytes';
  readonly tarball?: DeterministicPackageTarball;
}

type PreparedRegistryBody =
  | Exclude<
      LocalRegistryResponseBody,
      { readonly kind: 'delay' | 'package-tarball' }
    >
  | PreparedBytesBody
  | {
      readonly kind: 'delay';
      readonly milliseconds: number;
      readonly next: PreparedRegistryBody;
    };

interface PreparedRegistryResponse {
  readonly body: PreparedRegistryBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

export interface RecordedRegistryRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly pathname: string;
}

export interface LocalRegistryFixture {
  readonly baseUrl: URL;
  readonly requests: readonly RecordedRegistryRequest[];
  close(): Promise<void>;
}

async function prepareRegistryBody(options: {
  readonly body: LocalRegistryResponseBody;
  readonly tempRoot: string;
}): Promise<PreparedRegistryBody> {
  if (options.body.kind === 'package-tarball') {
    const tarball = await createDeterministicPackageTarball({
      files: options.body.files,
      tempRoot: options.tempRoot,
    });
    return {
      bytes: tarball.bytes,
      kind: 'prepared-bytes',
      tarball,
    };
  }
  if (options.body.kind === 'delay') {
    return {
      kind: 'delay',
      milliseconds: options.body.milliseconds,
      next: await prepareRegistryBody({
        body: options.body.next,
        tempRoot: options.tempRoot,
      }),
    };
  }

  return options.body;
}

async function prepareRegistryResponse(options: {
  readonly response: LocalRegistryResponse;
  readonly tempRoot: string;
}): Promise<PreparedRegistryResponse> {
  return {
    body: await prepareRegistryBody({
      body: options.response.body,
      tempRoot: options.tempRoot,
    }),
    headers: options.response.headers,
    status: options.response.status,
  };
}

function unwrapDelayedBody(body: PreparedRegistryBody): PreparedRegistryBody {
  return body.kind === 'delay' ? unwrapDelayedBody(body.next) : body;
}

function getPreparedBodyBytes(body: PreparedRegistryBody): Buffer | undefined {
  const resolved = unwrapDelayedBody(body);
  if (resolved.kind === 'prepared-bytes') {
    return resolved.bytes;
  }
  if (resolved.kind === 'bytes') {
    return Buffer.from(resolved.valueBase64, 'base64');
  }
  if (resolved.kind === 'text') {
    return Buffer.from(resolved.value);
  }
  if (resolved.kind === 'json') {
    return Buffer.from(JSON.stringify(resolved.value));
  }

  return undefined;
}

function resolveDigest(options: {
  readonly algorithm: 'sha1' | 'sha512';
  readonly declaration: LocalRegistryDigestDeclaration;
  readonly tarballBytes: Buffer | undefined;
}): unknown {
  if (options.declaration.kind === 'omit') {
    return undefined;
  }
  if (options.declaration.kind === 'value') {
    return options.declaration.value;
  }
  if (!options.tarballBytes) {
    throw new Error(
      `Registry ${options.declaration.kind} digest requires a materialized tarball body.`,
    );
  }

  const bytes =
    options.declaration.kind === 'actual'
      ? options.tarballBytes
      : Buffer.concat([
          options.tarballBytes,
          Buffer.from('\nintentional registry fixture mismatch\n'),
        ]);
  const digest = createHash(options.algorithm).update(bytes);

  return options.algorithm === 'sha1'
    ? digest.digest('hex')
    : `sha512-${digest.digest('base64')}`;
}

function createPackageMetadata(options: {
  readonly baseUrl: URL;
  readonly body: Extract<
    LocalRegistryResponseBody,
    { readonly kind: 'package-metadata' }
  >;
  readonly packageName: string;
  readonly tarballs: ReadonlyMap<string, PreparedRegistryResponse>;
}): unknown {
  const tarballResponse = options.body.tarballPath
    ? options.tarballs.get(options.body.tarballPath)
    : undefined;
  const tarballBytes = tarballResponse
    ? getPreparedBodyBytes(tarballResponse.body)
    : undefined;
  const dist: Record<string, unknown> = {};

  if (options.body.tarballPath !== undefined) {
    dist.tarball = new URL(
      options.body.tarballPath,
      options.baseUrl,
    ).toString();
  }
  const integrity = resolveDigest({
    algorithm: 'sha512',
    declaration: options.body.integrity,
    tarballBytes,
  });
  if (integrity !== undefined) {
    dist.integrity = integrity;
  }
  if (options.body.shasum !== undefined) {
    const shasum = resolveDigest({
      algorithm: 'sha1',
      declaration: options.body.shasum,
      tarballBytes,
    });
    if (shasum !== undefined) {
      dist.shasum = shasum;
    }
  }

  return {
    'dist-tags': {
      [options.body.distTag ?? 'latest']: options.body.version,
    },
    name: options.packageName,
    versions: {
      [options.body.version]: {
        dist,
        name: options.packageName,
        version: options.body.version,
      },
    },
  };
}

function recordRequest(request: IncomingMessage): RecordedRegistryRequest {
  const headers: Record<string, string> = {};
  for (const name of SAFE_RECORDED_HEADER_NAMES) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  return {
    headers,
    method: request.method ?? '',
    pathname: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
  };
}

function defaultContentType(body: PreparedRegistryBody): string {
  const resolved = unwrapDelayedBody(body);
  if (resolved.kind === 'json' || resolved.kind === 'package-metadata') {
    return 'application/json';
  }
  if (resolved.kind === 'prepared-bytes' || resolved.kind === 'bytes') {
    return 'application/octet-stream';
  }
  return 'text/plain; charset=utf-8';
}

function writeResponseHeaders(options: {
  readonly body: PreparedRegistryBody;
  readonly response: PreparedRegistryResponse;
  readonly serverResponse: ServerResponse;
}): void {
  options.serverResponse.writeHead(options.response.status ?? 200, {
    'content-type': defaultContentType(options.body),
    ...options.response.headers,
  });
}

async function sendRegistryBody(options: {
  readonly baseUrl: URL;
  readonly body: PreparedRegistryBody;
  readonly packageName: string;
  readonly request: IncomingMessage;
  readonly response: PreparedRegistryResponse;
  readonly serverResponse: ServerResponse;
  readonly tarballs: ReadonlyMap<string, PreparedRegistryResponse>;
  readonly timers: Set<NodeJS.Timeout>;
}): Promise<void> {
  if (options.body.kind === 'delay') {
    const delayedBody = options.body;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        options.timers.delete(timer);
        resolve();
      }, delayedBody.milliseconds);
      options.timers.add(timer);
      options.request.once('close', () => {
        if (options.timers.delete(timer)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    if (options.request.destroyed || options.serverResponse.destroyed) {
      return;
    }
    await sendRegistryBody({ ...options, body: delayedBody.next });
    return;
  }

  if (options.body.kind === 'close-connection') {
    options.request.socket.destroy();
    return;
  }
  if (options.body.kind === 'incomplete-body') {
    const bytes = Buffer.from(options.body.value);
    options.serverResponse.writeHead(options.response.status ?? 200, {
      'content-length': String(bytes.byteLength + 64),
      'content-type': defaultContentType(options.body),
      connection: 'close',
      ...options.response.headers,
    });
    options.serverResponse.flushHeaders();
    options.serverResponse.write(bytes);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        options.timers.delete(timer);
        options.serverResponse.socket?.destroy();
        resolve();
      }, 10);
      options.timers.add(timer);
    });
    return;
  }

  writeResponseHeaders({
    body: options.body,
    response: options.response,
    serverResponse: options.serverResponse,
  });

  if (options.body.kind === 'prepared-bytes') {
    options.serverResponse.end(options.body.bytes);
    return;
  }
  if (options.body.kind === 'bytes') {
    options.serverResponse.end(Buffer.from(options.body.valueBase64, 'base64'));
    return;
  }
  if (options.body.kind === 'text') {
    options.serverResponse.end(options.body.value);
    return;
  }
  const value =
    options.body.kind === 'package-metadata'
      ? createPackageMetadata({
          baseUrl: options.baseUrl,
          body: options.body,
          packageName: options.packageName,
          tarballs: options.tarballs,
        })
      : options.body.value;
  options.serverResponse.end(JSON.stringify(value));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function startLocalRegistryFixture(options: {
  readonly scenario: LocalRegistryScenario;
  readonly tempRoot: string;
}): Promise<LocalRegistryFixture> {
  const metadataPath = `/${encodeURIComponent(options.scenario.packageName)}`;
  const metadata = await prepareRegistryResponse({
    response: options.scenario.metadata,
    tempRoot: options.tempRoot,
  });
  const tarballs = new Map<string, PreparedRegistryResponse>();
  for (const [pathname, response] of Object.entries(
    options.scenario.tarballs ?? {},
  )) {
    tarballs.set(
      pathname,
      await prepareRegistryResponse({ response, tempRoot: options.tempRoot }),
    );
  }

  const recordedRequests: RecordedRegistryRequest[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let baseUrl: URL | undefined;
  let handlerFailure: unknown;
  let serverFailure: unknown;
  let closed = false;

  const server = createServer((request, serverResponse) => {
    const recorded = recordRequest(request);
    recordedRequests.push(recorded);
    const preparedResponse =
      recorded.pathname === metadataPath
        ? metadata
        : tarballs.get(recorded.pathname);

    if (!preparedResponse) {
      serverResponse.writeHead(404, { 'content-type': 'text/plain' });
      serverResponse.end('not found');
      return;
    }

    sendRegistryBody({
      baseUrl: baseUrl!,
      body: preparedResponse.body,
      packageName: options.scenario.packageName,
      request,
      response: preparedResponse,
      serverResponse,
      tarballs,
      timers,
    }).catch((error: unknown) => {
      handlerFailure ??= error;
      serverResponse.destroy(error as Error);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', (error) => {
    serverFailure ??= error;
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== '127.0.0.1') {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
    throw new Error('Local registry fixture did not bind to IPv4 loopback.');
  }
  baseUrl = new URL(`http://127.0.0.1:${String(address.port)}/`);

  return {
    baseUrl,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
      if (handlerFailure !== undefined) {
        throw handlerFailure;
      }
      if (serverFailure !== undefined) {
        throw serverFailure;
      }
    },
    get requests(): readonly RecordedRegistryRequest[] {
      return recordedRequests.map((request) => ({
        headers: { ...request.headers },
        method: request.method,
        pathname: request.pathname,
      }));
    },
  };
}

export function assertLocalRegistryRequests(options: {
  readonly actual: readonly RecordedRegistryRequest[];
  readonly expected: readonly ExpectedRegistryRequest[];
  readonly fixtureId: string;
}): void {
  if (options.actual.length !== options.expected.length) {
    throw new Error(
      `Detector fixture ${options.fixtureId} local registry request count mismatch: expected ${String(options.expected.length)}, received ${String(options.actual.length)}. Actual requests: ${JSON.stringify(options.actual)}`,
    );
  }

  for (const [index, expected] of options.expected.entries()) {
    const actual = options.actual[index]!;
    const expectedMethod = expected.method ?? 'GET';
    const headersMatch = Object.entries(expected.headers ?? {}).every(
      ([name, value]) => actual.headers[name.toLowerCase()] === value,
    );
    if (
      actual.method !== expectedMethod ||
      actual.pathname !== expected.pathname ||
      !headersMatch
    ) {
      throw new Error(
        `Detector fixture ${options.fixtureId} local registry request ${String(index)} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
      );
    }
  }
}

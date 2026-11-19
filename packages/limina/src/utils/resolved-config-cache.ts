import { AsyncLocalStorage } from 'node:async_hooks';

export interface ResolvedConfigIdentity {
  configPath: string;
  context: string;
}

export interface ResolvedConfigCodec<T> {
  requiredFiles?(value: T): readonly string[];
  encode(value: T): string | undefined;
  decode(payload: string): T | undefined;
}

export type ResolvedConfigResolver = <T>(
  identity: ResolvedConfigIdentity,
  closurePaths: readonly string[],
  parse: () => T,
  codec: ResolvedConfigCodec<T>,
) => T;

interface ResolvedConfigScope {
  resolve: ResolvedConfigResolver;
  parse: <T>(operation: () => T, key: string | undefined) => T;
}

const scopes = new AsyncLocalStorage<ResolvedConfigScope>();

export function withResolvedConfigCache<T>(
  scope: ResolvedConfigScope,
  operation: () => T,
): T {
  return scopes.run(scope, operation);
}

export const resolveCachedConfig: ResolvedConfigResolver = (
  identity,
  closurePaths,
  parse,
  codec,
) => {
  const scope = scopes.getStore();
  return scope === undefined
    ? parse()
    : scope.resolve(identity, closurePaths, parse, codec);
};

export function parseLiveConfig<T>(operation: () => T, key?: string): T {
  const scope = scopes.getStore();
  return scope === undefined ? operation() : scope.parse(operation, key);
}

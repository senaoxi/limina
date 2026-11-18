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
  parse: () => T,
  codec: ResolvedConfigCodec<T>,
) => T;

const resolvers = new AsyncLocalStorage<ResolvedConfigResolver>();

export function withResolvedConfigCache<T>(
  resolver: ResolvedConfigResolver,
  operation: () => T,
): T {
  return resolvers.run(resolver, operation);
}

export const resolveCachedConfig: ResolvedConfigResolver = (
  identity,
  parse,
  codec,
) => {
  const resolve = resolvers.getStore();
  return resolve === undefined ? parse() : resolve(identity, parse, codec);
};

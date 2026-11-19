import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { configFileStamp, readStampedConfig } from './config-file-stamp';
import { digestFile } from './file-digest';

export type AnalysisReadDescriptor =
  | { kind: 'directory' | 'directories' | 'realpath'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'content'; path: string }
  | { kind: 'file-digest'; path: string }
  | { kind: 'source-digest'; path: string }
  | { kind: 'file-size'; path: string }
  | { kind: 'typescript-content'; path: string }
  | { kind: 'config-text'; path: string }
  | { kind: 'file-identity'; path: string }
  | { kind: 'file-binding'; path: string }
  | {
      kind: 'ts-directory';
      arguments: [
        string,
        readonly string[] | null,
        readonly string[] | null,
        readonly string[] | null,
        number | null,
      ];
    }
  | {
      kind: 'glob';
      patterns: string[];
      options: {
        absolute: true;
        cwd: string;
        onlyDirectories?: boolean;
        onlyFiles?: boolean;
        expandDirectories?: boolean;
        dot?: boolean;
        followSymbolicLinks?: boolean;
        ignore: string[];
      };
      lexicalDirectories?: boolean;
    };

export interface AnalysisRead {
  descriptor?: AnalysisReadDescriptor;
  configStamp?: string;
  path: string;
  key: string;
  value: unknown;
  read(): unknown | Promise<unknown>;
}
export type AnalysisReadObserver = (input: AnalysisRead) => void;
const observations = new AsyncLocalStorage<AnalysisReadObserver>();

interface ReadDispatch {
  input: AnalysisRead;
  derived: Map<(input: AnalysisRead) => unknown, unknown>;
}
const dispatches: ReadDispatch[] = [];

export function withoutAnalysisReads<T>(operation: () => T): T {
  return observations.exit(operation);
}

/**
Scoped to a provider epoch; these callbacks are never persisted.
*/
export function withAnalysisReads<T>(
  observer: AnalysisReadObserver,
  operation: () => T,
): T {
  return observations.run(observer, operation);
}

/**
Record a context's own subscriptions without hiding the enclosing transaction.
*/
export function withAdditionalAnalysisReads<T>(
  observer: AnalysisReadObserver,
  operation: () => T,
): T {
  const parent = observations.getStore();
  return observations.run((input) => {
    parent?.(input);
    observer(input);
  }, operation);
}

export function observeAnalysisRead<T>(
  input: AnalysisRead,
  validated?: { derive: (input: AnalysisRead) => T; value: T },
): void {
  const observer = observations.getStore();
  if (observer === undefined) return;
  const derived = new Map<(input: AnalysisRead) => unknown, unknown>();
  if (validated !== undefined) derived.set(validated.derive, validated.value);
  dispatches.push({ input, derived });
  try {
    observer(input);
  } finally {
    dispatches.pop();
  }
}

/**
 * Read-only subscribers share derivations of one synchronous notification.
 * Neither the caller's object nor an asynchronous continuation extends it.
 */
export function deriveAnalysisRead<T>(
  input: AnalysisRead,
  derive: (input: AnalysisRead) => T,
): T {
  const currentDispatch = dispatches.at(-1);
  if (currentDispatch?.input !== input) return derive(input);
  const values = currentDispatch.derived;
  if (!values.has(derive)) values.set(derive, derive(input));
  return values.get(derive) as T;
}

export function readAnalysisInput<T>(
  path: string,
  read: () => T,
  purpose:
    | 'content'
    | 'file'
    | 'file-size'
    | 'source-digest'
    | 'directory'
    | 'directories'
    | 'realpath'
    | 'typescript-content'
    | 'file-binding'
    | 'file-identity' = 'content',
): T {
  const value = read();
  observeAnalysisRead({
    path,
    descriptor: { kind: purpose, path },
    key: JSON.stringify([purpose, path]),
    value,
    read,
  });
  return value;
}

export function readAnalysisFileDigest(path: string, bytes?: Buffer): string {
  const read = () => digestFile(path).hash;
  const value =
    bytes === undefined
      ? read()
      : createHash('sha256').update(bytes).digest('hex');
  observeAnalysisRead({
    path,
    descriptor: { kind: 'file-digest', path },
    key: JSON.stringify(['file-digest', path]),
    value,
    read,
  });
  return value;
}

// Associate a physical config read with metadata from both sides of the read.
export function readTypeScriptConfigInput(
  path: string,
  read: () => string | undefined,
): string | undefined {
  if (observations.getStore() === undefined) return read();
  const { value, configStamp } = readStampedConfig(
    path,
    read,
    configFileStamp(path),
  );
  observeAnalysisRead({
    key: JSON.stringify(['config-text', path]),
    path,
    descriptor: { kind: 'config-text', path },
    configStamp,
    value,
    read,
  });
  return value;
}

export function typeScriptDirectoryDescriptor(
  arguments_: readonly [
    string,
    (readonly string[] | undefined)?,
    (readonly string[] | undefined)?,
    (readonly string[] | undefined)?,
    number?,
  ],
): Extract<AnalysisReadDescriptor, { kind: 'ts-directory' }> {
  const root = arguments_[0];
  const optional = [
    arguments_[1],
    arguments_[2],
    arguments_[3],
    arguments_[4],
  ].map((value) => value ?? null);
  return {
    kind: 'ts-directory',
    arguments: [root, ...optional] as Extract<
      AnalysisReadDescriptor,
      { kind: 'ts-directory' }
    >['arguments'],
  };
}

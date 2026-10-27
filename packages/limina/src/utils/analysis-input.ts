import { AsyncLocalStorage } from 'node:async_hooks';

export type AnalysisReadDescriptor =
  | { kind: 'directory' | 'directories' | 'realpath'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'content'; path: string }
  | { kind: 'typescript-content'; path: string }
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
  path: string;
  key: string;
  value: unknown;
  read(): unknown | Promise<unknown>;
}
export type AnalysisReadObserver = (input: AnalysisRead) => void;
const observations = new AsyncLocalStorage<AnalysisReadObserver>();

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

export function observeAnalysisRead(input: AnalysisRead): void {
  observations.getStore()?.(input);
}

export function readAnalysisInput<T>(
  path: string,
  read: () => T,
  purpose:
    | 'content'
    | 'file'
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

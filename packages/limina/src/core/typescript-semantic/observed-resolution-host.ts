import { observeAnalysisRead, readAnalysisInput } from '#utils/analysis-input';
import path from 'node:path';
import type ts from 'typescript';

function observe<T>(
  kind: 'directory' | 'directories' | 'realpath',
  file: string,
  read: () => T,
): T {
  const value = read();
  observeAnalysisRead({
    path: file,
    key: JSON.stringify([kind, file]),
    descriptor: { kind, path: file },
    value,
    read,
  });
  return value;
}

export function observedResolutionHost(
  compiler: typeof ts,
  configPath: string,
): ts.ModuleResolutionHost {
  return {
    ...compiler.sys,
    getCurrentDirectory: () => path.dirname(configPath),
    fileExists: (file) =>
      readAnalysisInput(file, () => compiler.sys.fileExists(file), 'file'),
    readFile: (file) =>
      readAnalysisInput(
        file,
        () => compiler.sys.readFile(file),
        'typescript-content',
      ),
    directoryExists: (file) =>
      observe('directory', file, () => compiler.sys.directoryExists(file)),
    getDirectories: (file) =>
      observe('directories', file, () => compiler.sys.getDirectories(file)),
    realpath: (file) =>
      observe('realpath', file, () => compiler.sys.realpath!(file)),
  };
}

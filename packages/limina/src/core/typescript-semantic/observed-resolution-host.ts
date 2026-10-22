import {
  observeAnalysisRead,
  readAnalysisInput,
  typeScriptDirectoryDescriptor,
} from '#utils/analysis-input';
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
  system: ts.System = compiler.sys,
): ts.ModuleResolutionHost {
  return {
    ...system,
    getCurrentDirectory: () => path.dirname(configPath),
    fileExists: (file) =>
      readAnalysisInput(file, () => system.fileExists(file), 'file'),
    readFile: (file) =>
      readAnalysisInput(
        file,
        () => system.readFile(file),
        'typescript-content',
      ),
    directoryExists: (file) =>
      observe('directory', file, () => system.directoryExists(file)),
    getDirectories: (file) =>
      observe('directories', file, () => system.getDirectories(file)),
    realpath: (file) => observe('realpath', file, () => system.realpath!(file)),
  };
}

export function observedCompilerSystem(
  compiler: typeof ts,
  configPath: string,
  system: ts.System = compiler.sys,
): ts.System {
  return {
    ...system,
    ...observedResolutionHost(compiler, configPath, system),
    readDirectory: (...arguments_) => {
      const read = () => system.readDirectory(...arguments_);
      const value = read();
      const descriptor = typeScriptDirectoryDescriptor(arguments_);
      observeAnalysisRead({
        descriptor,
        key: JSON.stringify(descriptor),
        path: arguments_[0],
        value,
        read,
      });
      return value;
    },
    useCaseSensitiveFileNames: system.useCaseSensitiveFileNames,
  };
}

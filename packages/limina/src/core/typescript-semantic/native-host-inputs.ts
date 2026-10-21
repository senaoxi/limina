import {
  type AnalysisReadDescriptor,
  observeAnalysisRead,
  readAnalysisInput,
} from '#utils/analysis-input';
import type ts from 'typescript';

/**
Every compiler input remains replayable, including negative resolution reads.
*/
export function observeNativeHostInputs(host: ts.CompilerHost): void {
  const readFile = host.readFile.bind(host);
  host.readFile = (file) =>
    readAnalysisInput(file, () => readFile(file), 'typescript-content');
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) =>
    readAnalysisInput(file, () => fileExists(file), 'file');
  attachDirectoryReads(host);
  const realpath = host.realpath?.bind(host);
  if (realpath !== undefined)
    host.realpath = (file) =>
      observePathRead(file, 'realpath', () => realpath(file));
}

function attachDirectoryReads(host: ts.CompilerHost): void {
  const directoryExists = host.directoryExists?.bind(host);
  if (directoryExists !== undefined)
    host.directoryExists = (file) =>
      observePathRead(file, 'directory', () => directoryExists(file));
  attachDirectoryEnumeration(host);
}

function attachDirectoryEnumeration(host: ts.CompilerHost): void {
  const getDirectories = host.getDirectories?.bind(host);
  if (getDirectories !== undefined)
    host.getDirectories = (file) =>
      observePathRead(file, 'directories', () => getDirectories(file));
}

function observePathRead<T>(
  file: string,
  kind: Extract<
    AnalysisReadDescriptor,
    { kind: 'directory' | 'directories' | 'realpath' }
  >['kind'],
  read: () => T,
): T {
  const value = read();
  observeAnalysisRead({
    path: file,
    descriptor: { kind, path: file },
    key: JSON.stringify([kind, file]),
    value,
    read,
  });
  return value;
}

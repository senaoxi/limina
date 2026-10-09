import { isDeepStrictEqual } from 'node:util';
import type {
  ConfigModuleFile,
  ConfigModuleSnapshot,
} from '../core/analysis-cache/contracts';
export interface ConfigModuleComparison {
  kind: 'match' | 'mismatch' | 'unknown';
  reason: string;
}
function incomplete(
  previous: ConfigModuleSnapshot | undefined,
  current: ConfigModuleSnapshot,
): string | undefined {
  return previous === undefined
    ? 'missing'
    : incompleteReason(previous, current);
}
function incompleteReason(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): string | undefined {
  if (!previous.complete) return 'old-incomplete';
  return current.complete ? undefined : 'current-incomplete';
}
function hasEntry(snapshot: ConfigModuleSnapshot, path: string): boolean {
  return snapshot.files.some(
    (file) => hasEntryPath(file, path) && file.role === 'module',
  );
}
function members(snapshot: ConfigModuleSnapshot): unknown {
  return snapshot.files.map((file) => [file.path, file.role]);
}
function hasMatchingBinding(
  old: ConfigModuleFile,
  file: ConfigModuleFile,
): boolean {
  return [
    old.binding === file.binding,
    old.metadata.kind === file.metadata.kind,
    old.format === file.format,
    old.logicalBinding === file.logicalBinding,
    old.logicalPath === file.logicalPath,
  ].every(Boolean);
}
function hasEntryPath(file: ConfigModuleFile, path: string): boolean {
  return [file.path, file.logicalPath].includes(path);
}
function compareFile(
  old: ConfigModuleFile,
  file: ConfigModuleFile,
): ConfigModuleComparison | undefined {
  return hasMatchingBinding(old, file)
    ? compareContent(old, file)
    : { kind: 'mismatch', reason: 'binding-or-kind' };
}
function compareContent(
  old: ConfigModuleFile,
  file: ConfigModuleFile,
): ConfigModuleComparison | undefined {
  if (file.metadata.kind === 'missing') return undefined;
  return [old.contentHash === null, file.contentHash === null].some(Boolean)
    ? { kind: 'unknown', reason: 'content' }
    : contentMismatch(old, file);
}
function contentMismatch(
  old: ConfigModuleFile,
  file: ConfigModuleFile,
): ConfigModuleComparison | undefined {
  return old.contentHash === file.contentHash &&
    loadedSourceHash(old) === loadedSourceHash(file)
    ? undefined
    : { kind: 'mismatch', reason: 'content' };
}
function loadedSourceHash(file: ConfigModuleFile): string | undefined {
  return file.loadedSource?.contentHash;
}
function compareMembers(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): ConfigModuleComparison | undefined {
  if (!isDeepStrictEqual(members(previous), members(current)))
    return { kind: 'mismatch', reason: 'members' };
  return isDeepStrictEqual(previous.dependencies, current.dependencies)
    ? compareRelations(previous, current)
    : { kind: 'mismatch', reason: 'dependencies' };
}
function compareRelations(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): ConfigModuleComparison | undefined {
  return isDeepStrictEqual(previous.resolutions, current.resolutions)
    ? compareFiles(previous, current)
    : { kind: 'mismatch', reason: 'resolutions' };
}
function compareFiles(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): ConfigModuleComparison | undefined {
  for (const [index, file] of current.files.entries()) {
    const result = compareFile(previous.files[index], file);
    if (result !== undefined) return result;
  }
  return undefined;
}
function compareStructure(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
  configPath: string,
): ConfigModuleComparison {
  if (previous.loader !== current.loader)
    return { kind: 'mismatch', reason: 'loader' };
  return [previous, current].some((snapshot) => !hasEntry(snapshot, configPath))
    ? { kind: 'unknown', reason: 'entry-missing' }
    : matchedMembers(previous, current);
}
/**
Qualify known configuration facts before adopting any old analysis inputs.
*/
export function compareConfigModules(
  previous: ConfigModuleSnapshot | undefined,
  current: ConfigModuleSnapshot,
  configPath: string,
): ConfigModuleComparison {
  const reason = incomplete(previous, current);
  return reason === undefined
    ? compareStructure(previous!, current, configPath)
    : { kind: 'unknown', reason };
}

function matchedMembers(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): ConfigModuleComparison {
  return (
    compareMembers(previous, current) ?? { kind: 'match', reason: 'match' }
  );
}

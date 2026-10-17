import ts from 'typescript';
import type { TypeScriptSemanticProject } from './contracts';
export class NativeCapabilityError extends Error {}
export function assertNativeCapability(
  project: TypeScriptSemanticProject,
): void {
  const isUnsupported = [
    ts.version !== '6.0.3',
    hasVirtualFiles(project),
    project.projectReferences?.length,
  ].some(Boolean);
  if (isUnsupported)
    throw new NativeCapabilityError(
      'native adapter requires physical TypeScript 6.0.3 inputs without original reference redirects',
    );
}
export function assertNativeInput(file: string): void {
  if (!/\.(?:[cm]?ts|tsx)$/.test(file))
    throw new NativeCapabilityError(`unsupported support input: ${file}`);
}

function hasVirtualFiles(project: TypeScriptSemanticProject): boolean {
  return (project.virtualFiles?.size ?? 0) > 0;
}

import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticProject } from './contracts';
import type {
  DependencyRequestTemplate,
  FileDependencyFacts,
} from './file-dependency-facts';
import type { FileModuleContext } from './native-request-api';
import { isExternalDependencyFile } from './request-context';
function implicitRequest(
  filePath: string,
  input: { kind: ImportRecord['kind']; specifier: string; ordinal: number },
): DependencyRequestTemplate {
  return {
    governance: true,
    expansion: true,
    occurrence: {
      domain: 'typescript',
      filePath,
      kind: input.kind,
      specifier: input.specifier,
      line: 0,
      locator: { occurrence: input.ordinal, sourceStart: -1, sourceEnd: -1 },
    },
  };
}
function canUseImplicit(
  file: FileDependencyFacts,
  options: ts.CompilerOptions,
  isExternal: boolean,
): boolean {
  return (
    !file.declaration &&
    [isExternal, options.isolatedModules, options.verbatimModuleSyntax].some(
      Boolean,
    )
  );
}
function isAutomaticRuntime(
  file: FileDependencyFacts,
  options: ts.CompilerOptions,
  pragma: ImportRecord | undefined,
): boolean {
  return [
    options.jsx === ts.JsxEmit.ReactJSX,
    options.jsx === ts.JsxEmit.ReactJSXDev,
    options.jsxImportSource !== undefined,
    pragma !== undefined,
    file.jsxRuntime === 'automatic',
  ].some(Boolean);
}
function runtimeRequest(
  file: FileDependencyFacts,
  project: TypeScriptSemanticProject,
  pragma: ImportRecord | undefined,
): DependencyRequestTemplate {
  const base = runtimeBase(project, pragma);
  const suffix =
    project.options.jsx === ts.JsxEmit.ReactJSXDev
      ? 'jsx-dev-runtime'
      : 'jsx-runtime';
  const request = implicitRequest(file.filePath, {
    kind: 'jsx-import-source',
    specifier: `${base}/${suffix}`,
    ordinal: -1,
  });
  request.occurrence.configurationSource = {
    configPath: project.configPath,
    option: 'jsxImportSource',
    resolutionMode: undefined,
  };
  return request;
}
function addRuntime(
  requests: DependencyRequestTemplate[],
  file: FileDependencyFacts,
  project: TypeScriptSemanticProject,
): void {
  if (file.jsxRuntime === 'classic') return;
  const pragma = runtimePragma(requests);
  if (isAutomaticRuntime(file, project.options, pragma))
    requests.push(runtimeRequest(file, project, pragma));
}
function addImplicit(
  requests: DependencyRequestTemplate[],
  file: FileDependencyFacts,
  project: TypeScriptSemanticProject,
): void {
  if (project.options.importHelpers)
    requests.push(
      implicitRequest(file.filePath, {
        kind: 'static',
        specifier: 'tslib',
        ordinal: -2,
      }),
    );
  addRuntime(requests, file, project);
}
function isConcreteRequest(request: DependencyRequestTemplate): boolean {
  return (
    request.occurrence.kind !== 'jsx-import-source' ||
    request.occurrence.locator.sourceStart === -1
  );
}
function isApplicableRequest(
  request: DependencyRequestTemplate,
  isExternal: boolean,
): boolean {
  return (
    (!request.externalModuleOnly || isExternal) && isConcreteRequest(request)
  );
}
export function bindDependencyRequests(
  file: FileDependencyFacts,
  project: TypeScriptSemanticProject,
  format: FileModuleContext,
): DependencyRequestTemplate[] {
  const requests = structuredClone(file.requests);
  const isExternal = isExternalDependencyFile(file, project.options, format);
  if (canUseImplicit(file, project.options, isExternal))
    addImplicit(requests, file, project);
  return requests.filter((request) => isApplicableRequest(request, isExternal));
}

function runtimeBase(
  project: TypeScriptSemanticProject,
  pragma: ImportRecord | undefined,
): string {
  return pragma === undefined
    ? (project.options.jsxImportSource ?? 'react')
    : pragma.specifier;
}
function runtimePragma(
  requests: DependencyRequestTemplate[],
): ImportRecord | undefined {
  return requests.findLast(
    (request) => request.occurrence.kind === 'jsx-import-source',
  )?.occurrence;
}

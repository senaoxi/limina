import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import type { DependencyAnalysisResult } from './types';

interface ModuleProjectionInput {
  request: NativeRequest;
  target: string;
  external: boolean | null;
  compilerVersion: string;
}

/** Only actual locked requests supply the expected selection. These probes
 * validate configuration relocation; they create no source facts or edges. */
export function moduleProjectionInputs(
  analysis: DependencyAnalysisResult,
): Map<string, ModuleProjectionInput[]> {
  const inputs = new Map<string, ModuleProjectionInput[]>();
  const evidence = analysis.nativeEvidence ?? [];
  for (const { snapshot } of evidence) {
    for (const context of snapshot.contexts) {
      if (
        context.authority.phase !== 'locked' ||
        context.authority.family !== 'typescript' ||
        context.inputs.config !== context.inputs.sourceConfig
      )
        continue;
      const entries = inputs.get(context.inputs.config) ?? [];
      for (const request of snapshot.requests) {
        if (
          request.consumerContextId !== context.id ||
          request.channel !== 'module' ||
          request.sourceFile === null ||
          ts.isExternalModuleNameRelative(request.specifier)
        )
          continue;
        const resolution = snapshot.resolutions.find(
          (item) => item.requestId === request.id,
        );
        if (resolution?.state !== 'resolved' || resolution.target === null)
          continue;
        entries.push({
          request,
          target: resolution.target.lexicalPath,
          external: resolution.externalLibrary,
          compilerVersion: context.inputs.typescriptVersion,
        });
      }
      if (entries.length > 0) inputs.set(context.inputs.config, entries);
    }
  }
  return inputs;
}

export function validateModuleProjection(input: {
  generatedConfig: string;
  parsed: ts.ParsedCommandLine;
  files: ReadonlyMap<string, string>;
  requests: readonly ModuleProjectionInput[];
}): void {
  const host = withVirtualResolutionFiles(
    observedResolutionHost(ts, input.generatedConfig),
    input.files,
  );
  const roots = new Set(input.parsed.fileNames.map(normalizeAbsolutePath));
  for (const entry of input.requests) {
    const file = entry.request.sourceFile!.lexicalPath;
    if (!roots.has(file)) continue;
    const mode = resolutionMode(entry);
    const resolved = ts.resolveModuleName(
      entry.request.specifier,
      file,
      input.parsed.options,
      host,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    if (
      resolved === undefined ||
      normalizeAbsolutePath(resolved.resolvedFileName) !== entry.target ||
      Boolean(resolved.isExternalLibraryImport) !== entry.external
    )
      throw new DeclarationObservationUnavailable(
        `Generated module resolution changes a compiler request: ${input.generatedConfig}\n  ${file}: ${entry.request.specifier}\n  source: ${entry.target}\n  generated: ${resolved?.resolvedFileName ?? 'unresolved'}. Preserve the source package mapping before generating references.`,
      );
  }
}

function resolutionMode(entry: ModuleProjectionInput): ts.ResolutionMode {
  if (entry.compilerVersion !== ts.version)
    throw new DeclarationObservationUnavailable(
      'Module projection compiler identity changed.',
    );
  const mode = entry.request.resolutionMode;
  if (mode === null) return undefined;
  if (mode === String(ts.ModuleKind.CommonJS)) return ts.ModuleKind.CommonJS;
  if (mode === String(ts.ModuleKind.ESNext)) return ts.ModuleKind.ESNext;
  throw new DeclarationObservationUnavailable(
    `Unqualified module resolution mode: ${mode}`,
  );
}

import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import {
  resolveVersionQualifiedModule,
  resolveVersionQualifiedTypeDirective,
} from './checker-version-conditions';
import {
  jsonMembershipInputs,
  validateJsonInputMembership,
} from './json-input-membership';
import type { TypeInputProjectionReceipt } from './type-input-projection';
import type { DependencyAnalysisResult } from './types';

interface ModuleProjectionInput {
  request: NativeRequest;
  target: string | null;
  external: boolean | null;
  compilerVersion: string;
  requiresJsonMembership: boolean;
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
      const jsonInputs = jsonMembershipInputs(snapshot, context.id);
      for (const request of snapshot.requests) {
        if (
          request.consumerContextId !== context.id ||
          !['module', 'path-directive', 'type-directive'].includes(
            request.channel,
          ) ||
          (request.sourceFile === null && request.channel !== 'type-directive')
        )
          continue;
        const resolution = snapshot.resolutions.find(
          (item) => item.requestId === request.id,
        );
        if (
          resolution?.state !== 'unresolved' &&
          (resolution?.state !== 'resolved' || resolution.target === null)
        )
          continue;
        const requiresJsonMembership = jsonInputs.has(request.id);
        if (!requiresJsonMembership && request.channel === 'path-directive')
          continue;
        entries.push({
          request,
          target: resolution.target?.lexicalPath ?? null,
          external: resolution.externalLibrary,
          compilerVersion: context.inputs.typescriptVersion,
          requiresJsonMembership,
        });
      }
      if (entries.length > 0) inputs.set(context.inputs.config, entries);
    }
  }
  return inputs;
}

interface ProjectionValidationInput {
  sourceConfig: string;
  generatedConfig: string;
  parsed: ts.ParsedCommandLine;
  files: ReadonlyMap<string, string>;
  requests: readonly ModuleProjectionInput[];
  checker: string;
  preset?: string;
  executionRoot?: string;
  typeInputProjection?: TypeInputProjectionReceipt;
}

export function validateModuleProjection(
  input: ProjectionValidationInput,
): void {
  const host = withVirtualResolutionFiles(
    observedResolutionHost(ts, input.generatedConfig),
    input.files,
  );
  validateJsonInputMembership(
    input.requests.flatMap((entry) =>
      entry.requiresJsonMembership && entry.target !== null
        ? [entry.target]
        : [],
    ),
    input.parsed.fileNames,
    input.generatedConfig,
  );
  for (const entry of input.requests) {
    if (entry.request.channel === 'type-directive') {
      if ((input.preset ?? input.checker) === 'tsgo')
        qualifyTypeDirective(entry, input, host);
      continue;
    }
    const file = entry.request.sourceFile!.lexicalPath;
    // The locked inventory already enforces the declaration frontier. A
    // consumer-retained declaration need not be a parsed root; do not drop its
    // requests or expand a delegated provider's private closure here.
    if (
      entry.request.channel !== 'module' ||
      (ts.isExternalModuleNameRelative(entry.request.specifier) &&
        (input.preset ?? input.checker) !== 'tsgo')
    )
      continue;
    const mode = resolutionMode(entry);
    const resolved =
      (input.preset ?? input.checker) === 'tsgo'
        ? resolveVersionQualifiedModule({
            specifier: entry.request.specifier,
            file,
            options: input.parsed.options,
            host,
            mode,
            executionRoot: input.executionRoot,
          })
        : ts.resolveModuleName(
            entry.request.specifier,
            file,
            input.parsed.options,
            host,
            undefined,
            undefined,
            mode,
          ).resolvedModule;
    // A completed miss still needs Checker qualification: another compiler
    // version may select an implementation and require a project reference.
    // A preserved miss is an ordinary Checker diagnostic, not a graph defect.
    if (resolved === undefined && entry.target === null) continue;
    if (
      resolved === undefined ||
      normalizeAbsolutePath(resolved.resolvedFileName) !== entry.target ||
      Boolean(resolved.isExternalLibraryImport) !== entry.external
    )
      throw new DeclarationObservationUnavailable(
        `Generated module resolution changes a compiler request: ${input.generatedConfig}\n  ${file}: ${entry.request.specifier}\n  source: ${entry.target ?? 'unresolved'}\n  generated: ${resolved?.resolvedFileName ?? 'unresolved'}. Preserve the source package mapping before generating references.`,
      );
  }
}

function qualifyTypeDirective(
  entry: ModuleProjectionInput,
  input: ProjectionValidationInput,
  generatedHost: ts.ModuleResolutionHost,
): void {
  const receipt = input.typeInputProjection;
  if (
    receipt?.sourceConfig !== input.sourceConfig ||
    receipt.generatedConfig !== input.generatedConfig ||
    receipt.compilerVersion !== entry.compilerVersion
  )
    throw new DeclarationObservationUnavailable(
      'Type directive projection identity is unavailable.',
    );
  const source = entry.request.sourceFile?.lexicalPath;
  const mode = resolutionMode(entry);
  // Projected typeRoots or pinned names can hide the source's visited exports
  // conditions. Qualify both real contexts without discovering new requests.
  resolveVersionQualifiedTypeDirective({
    specifier: entry.request.specifier,
    file:
      source ??
      path.join(path.dirname(input.sourceConfig), '__inferred type names__.ts'),
    options: receipt.sourceOptions,
    host: withVirtualResolutionFiles(
      observedResolutionHost(ts, input.sourceConfig),
      input.files,
    ),
    mode,
    executionRoot: input.executionRoot,
  });
  const index =
    source === undefined
      ? receipt.source.findIndex(
          (value) => value.name === entry.request.specifier,
        )
      : -1;
  const projected =
    source === undefined
      ? receipt.generated[index]?.name
      : entry.request.specifier;
  if (projected === undefined)
    throw new DeclarationObservationUnavailable(
      'Type directive projection has no corresponding config entry.',
    );
  resolveVersionQualifiedTypeDirective({
    specifier: projected,
    file:
      source ??
      path.join(
        path.dirname(input.generatedConfig),
        '__inferred type names__.ts',
      ),
    options: input.parsed.options,
    host: generatedHost,
    mode,
    executionRoot: input.executionRoot,
  });
}

function resolutionMode(entry: ModuleProjectionInput): ts.ResolutionMode {
  if (entry.compilerVersion !== ts.version)
    throw new DeclarationObservationUnavailable(
      'Compiler request projection identity changed.',
    );
  const mode = entry.request.resolutionMode;
  if (mode === null) return undefined;
  if (mode === String(ts.ModuleKind.CommonJS)) return ts.ModuleKind.CommonJS;
  if (mode === String(ts.ModuleKind.ESNext)) return ts.ModuleKind.ESNext;
  throw new DeclarationObservationUnavailable(
    `Unqualified request resolution mode: ${mode}`,
  );
}

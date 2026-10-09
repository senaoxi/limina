import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import path from 'pathe';
import type { ConfigResolution } from '../core/analysis-cache/contracts';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import type { ConfigModuleEvidence } from './load-evidence';
export type ObservedConfigResolution = Omit<
  ConfigResolution,
  'importAttributes'
> & { importAttributes?: Record<string, string | undefined> };
function requestedPath(edge: ConfigResolution): string | undefined {
  return [
    edge.specifier.startsWith('.'),
    edge.specifier.startsWith('file:'),
  ].some(Boolean)
    ? normalizeAbsolutePath(
        fileURLToPath(new URL(edge.specifier, edge.parentURL)),
      )
    : undefined;
}
function hasBindingConflict(
  previous: string | undefined,
  binding: string,
): boolean {
  return previous !== undefined && previous !== binding;
}
function hasResolutionConflict(
  previous: ConfigResolution | undefined,
  edge: ConfigResolution,
): boolean {
  return previous !== undefined && !isDeepStrictEqual(previous, edge);
}
function requestBinding(
  evidence: ConfigModuleEvidence,
  edge: ConfigResolution,
): void {
  const requested = requestedPath(edge);
  if (requested === undefined) return;
  const binding = analysisHash(pathBinding(requested));
  edge.requestBinding = { path: requested, binding };
  if (hasBindingConflict(evidence.requestBindings.get(requested), binding))
    evidence.unknown.add('resolution-binding-conflict');
  evidence.requestBindings.set(requested, binding);
}
function record(evidence: ConfigModuleEvidence, edge: ConfigResolution): void {
  requestBinding(evidence, edge);
  const key = JSON.stringify([
    edge.parentURL,
    edge.specifier,
    edge.conditions,
    edge.importAttributes,
  ]);
  if (hasResolutionConflict(evidence.resolutions.get(key), edge))
    evidence.unknown.add('resolution-conflict');
  else evidence.resolutions.set(key, edge);
}
function requestProtocol(specifier: string): string | undefined {
  if (path.isAbsolute(specifier)) return undefined;
  try {
    return new URL(specifier).protocol;
  } catch {
    return undefined;
  }
}
function hasObservableSource(raw: ObservedConfigResolution): boolean {
  return [
    raw.resolvedURL.startsWith('file:') || raw.resolvedURL.startsWith('node:'),
    [undefined, 'file:', 'node:'].includes(requestProtocol(raw.specifier)),
  ].every(Boolean);
}
function recordAttributes(
  evidence: ConfigModuleEvidence,
  raw: ObservedConfigResolution,
): void {
  const attributes = raw.importAttributes ?? {};
  if (Object.values(attributes).some((value) => typeof value !== 'string')) {
    evidence.unknown.add('resolution-attributes-unknown');
    return;
  }
  const ordered = Object.entries(attributes as Record<string, string>).sort(
    ([a], [b]) => compareCodeUnits(a, b),
  );
  record(evidence, {
    ...raw,
    conditions: [...raw.conditions].sort(compareCodeUnits),
    importAttributes: Object.fromEntries(ordered),
  });
}
export function observeConfigResolution(
  evidence: ConfigModuleEvidence,
  raw: ObservedConfigResolution,
): void {
  // Opaque schemes may embed source or credentials; persist only the reason.
  if (hasObservableSource(raw)) {
    recordConditions(evidence, raw);
  } else {
    evidence.unknown.add('module-scheme-unknown');
  }
}
function recordConditions(
  evidence: ConfigModuleEvidence,
  raw: ObservedConfigResolution,
): void {
  if (raw.conditions.some((condition) => typeof condition !== 'string'))
    evidence.unknown.add('resolution-conditions-unknown');
  else recordAttributes(evidence, raw);
}

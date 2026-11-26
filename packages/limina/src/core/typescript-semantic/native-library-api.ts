import type ts from 'typescript';
import { NativeObservationError } from './native-observation-failure';

interface LibraryApi {
  getLibFileNameFromLibReference?(
    reference: Pick<ts.FileReference, 'fileName'>,
  ): string | undefined;
  libMap: ReadonlyMap<string, string>;
  toFileNameLowerCase(name: string): string;
}

export function nativeLibraryFileNames(compiler: typeof ts): string[] {
  const api = compiler as unknown as LibraryApi;
  if (!(api.libMap instanceof Map))
    throw new NativeObservationError(
      'unsupported',
      'Native library map unavailable.',
    );
  return [...new Set(api.libMap.values())];
}

export function nativeLibraryFileName(
  compiler: typeof ts,
  reference: Pick<ts.FileReference, 'fileName'>,
): string | undefined {
  const api = compiler as unknown as LibraryApi;
  if (/^5\.[4-7]\./.test(compiler.version))
    return legacyLibraryFileName(api, reference);
  if (typeof api.getLibFileNameFromLibReference !== 'function')
    throw new NativeObservationError(
      'unsupported',
      'Native library map unavailable.',
    );
  return api.getLibFileNameFromLibReference(reference);
}

function legacyLibraryFileName(
  api: LibraryApi,
  reference: Pick<ts.FileReference, 'fileName'>,
) {
  if (
    !(api.libMap instanceof Map) ||
    typeof api.toFileNameLowerCase !== 'function'
  )
    throw new NativeObservationError(
      'unsupported',
      'Native library map unavailable.',
    );
  // The pre-5.8 helper is private; use its compiler-owned map and normalizer.
  return api.libMap.get(api.toFileNameLowerCase(reference.fileName));
}

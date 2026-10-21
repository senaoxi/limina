import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { ProjectDependencyCaches } from './contracts';

export function retainNativeObservation(
  caches: ProjectDependencyCaches | undefined,
  snapshot: NativeEvidenceSnapshot | undefined,
): void {
  if (caches === undefined || snapshot === undefined) return;
  storeNativeObservation(caches, snapshot);
}

function storeNativeObservation(
  caches: ProjectDependencyCaches,
  snapshot: NativeEvidenceSnapshot,
): void {
  caches.nativeObservations ??= new Map();
  const id = nativeFingerprint([
    snapshot.contexts.map((context) => context.id),
    snapshot.failures.map((failure) => failure.id),
  ]);
  caches.nativeObservations.set(id, snapshot);
}

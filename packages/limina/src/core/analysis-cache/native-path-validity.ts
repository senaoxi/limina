import type {
  NativeEvidenceSnapshot,
  NativeResolution,
} from '../../domain/analysis/native-evidence';

/**
Path selection belongs to the cached occurrence, not a post-load endpoint.
*/
export function hasBoundPathSelections(
  snapshot: NativeEvidenceSnapshot,
): boolean {
  return snapshot.requests
    .filter((request) => request.channel === 'path-directive')
    .every((request) =>
      hasPathSelection(
        snapshot.resolutions.find(
          (resolution) => resolution.requestId === request.id,
        ),
      ),
    );
}
function hasPathSelection(resolution: NativeResolution | undefined): boolean {
  return resolution !== undefined && hasReceipt(resolution);
}
function hasReceipt(resolution: NativeResolution): boolean {
  if (resolution.pathSelection === undefined) return false;
  return resolution.pathSelection.state === 'selected'
    ? hasSelectedTarget(resolution)
    : resolution.target === null;
}
function hasSelectedTarget(resolution: NativeResolution): boolean {
  const selection = resolution.pathSelection!;
  const firstPresent = selection.candidates.find(
    (candidate) => candidate.present,
  );
  if (firstPresent === undefined) return false;
  return [
    resolution.state === 'resolved',
    firstPresent.lexicalPath === selection.logicalTarget,
    firstPresent.physicalPath === resolution.target?.lexicalPath,
  ].every(Boolean);
}

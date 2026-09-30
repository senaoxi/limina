import { isValidVersion } from './shared';

export function assertNewReleaseTag(
  tag: string,
  historicalTags: readonly string[],
): string {
  const version = tag.startsWith('limina/v')
    ? tag.slice('limina/v'.length)
    : '';
  if (version !== version.trim() || !isValidVersion(version)) {
    throw new Error('Expected a new limina/v<version> release tag.');
  }
  if (historicalTags.includes(tag)) {
    throw new Error('Imported historical tags cannot publish or deploy.');
  }
  return version;
}

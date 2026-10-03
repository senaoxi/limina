import { isValidVersion } from './shared';

// Tags imported from the fixed docs-islands extraction baseline. Keep rejecting
// their names even if a local tag is moved to a newer commit.
const historicalTags = new Set([
  'limina/v0.0.4',
  'limina/v0.0.5',
  'limina/v0.0.6',
  'limina/v0.1.0',
  'limina/v0.1.1',
  'limina/v0.1.2',
  'limina/v0.1.3',
  'limina/v0.2.0',
  'limina/v0.2.1',
  'limina/v0.2.2',
  'limina/v0.2.3',
  'limina/v0.3.0',
  'limina/v0.3.1',
  'limina/v0.4.0',
]);

export function assertNewReleaseTag(tag: string): string {
  const version = tag.startsWith('limina/v')
    ? tag.slice('limina/v'.length)
    : '';
  if (version !== version.trim() || !isValidVersion(version)) {
    throw new Error('Expected a new limina/v<version> release tag.');
  }
  if (historicalTags.has(tag)) {
    throw new Error('Imported historical tags cannot publish or deploy.');
  }
  return version;
}

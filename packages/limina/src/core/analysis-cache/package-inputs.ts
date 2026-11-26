import { compareCodeUnits } from '#utils/collections';
import { readdirSync, statSync } from 'node:fs';
import path from 'pathe';
import { packageManifestState, pathBinding } from './directory-fingerprint';

import { physicalEntry } from './physical-entry';

/**
TypeScript enumerates immediate type packages. Their declaration trees are trusted until --force.
*/
export function typePackageInventory(root: string): unknown {
  const directory = statSync(root, { throwIfNoEntry: false });
  const packages = directory?.isDirectory()
    ? readdirSync(root)
        .sort(compareCodeUnits)
        .flatMap((name) => {
          if (name.startsWith('.')) return [];
          const member = path.join(root, name);
          if (!statSync(member, { throwIfNoEntry: false })?.isDirectory())
            return [];
          return [
            [
              name,
              pathBinding(member),
              physicalEntry(member),
              packageManifestState(path.join(member, 'package.json')),
            ],
          ];
        })
    : [];
  return [pathBinding(root), physicalEntry(root), packages];
}

export function packageLocation(file: string): string | undefined {
  const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(file);
  return match?.[1];
}

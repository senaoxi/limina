import { createPackagePlugin } from '@docs-islands/utils/package-plugin';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';

const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default function generatePackage(): Plugin {
  return createPackagePlugin({
    packageJsonPath,
    rewriteTypes: true,
  });
}

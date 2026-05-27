import { createPackageJsonPlugin } from '@docs-islands/utils/package-plugin';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';

const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default function generatePackageJson(): Plugin {
  return createPackageJsonPlugin({
    packageJsonPath,
    rewriteTypes: true,
  });
}

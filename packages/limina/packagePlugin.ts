import { createPackagePlugin } from '@limina/build-tools/package-plugin';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';

const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default function generatePackage(): Plugin {
  return createPackagePlugin({
    packageJsonPath,
    rewriteTypes: true,
    transformPackageJson(packageJson) {
      // Keep the source bridge in the workspace; it is not a published API.
      delete packageJson.exports?.['./internal/migration'];
    },
  });
}

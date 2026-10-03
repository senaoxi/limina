import { createPackagePlugin } from '@limina/build-tools/package-plugin';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';

const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default function generatePackage(): Plugin {
  return createPackagePlugin({
    packageJsonPath,
    rewriteTypes: true,
    transformPackageJson(packageJson) {
      // Internal source modules are workspace-only and never a published API.
      const exportKeys = Object.keys(packageJson.exports ?? {});
      for (const key of exportKeys) {
        if (key === './internal' || key.startsWith('./internal/')) {
          delete packageJson.exports?.[key];
        }
      }
    },
  });
}

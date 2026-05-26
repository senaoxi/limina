import { createPackageJsonPlugin } from '@docs-islands/utils/package-plugin';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';

const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));
const packageReadmePath = fileURLToPath(new URL('README.md', import.meta.url));
const workspaceLicensePath = fileURLToPath(
  new URL('../../LICENSE', import.meta.url),
);

export default function generatePackageJson(): Plugin {
  return createPackageJsonPlugin({
    emitAssets: [
      {
        fileName: 'README.md',
        sourcePath: packageReadmePath,
      },
      {
        fileName: 'LICENSE.md',
        sourcePath: workspaceLicensePath,
      },
    ],
    packageJsonPath,
    rewriteTypes: true,
  });
}

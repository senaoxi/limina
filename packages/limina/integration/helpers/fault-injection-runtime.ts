import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const faultLauncherPath = fileURLToPath(
  new URL('fault-injection-launcher.ts', import.meta.url),
);
const tsxLoaderPath = createRequire(import.meta.url).resolve('tsx');

// Node's `--import` flag requires a URL specifier. A bare Windows drive path
// would be interpreted as an unsupported URL scheme, so always use file://.
const tsxLoaderSpecifier = pathToFileURL(tsxLoaderPath).href;

export interface FaultInjectionRuntimeEntry {
  readonly args: readonly string[];
  readonly executable: string;
}

export function createFaultInjectionRuntimeEntry(): FaultInjectionRuntimeEntry {
  return {
    args: ['--import', tsxLoaderSpecifier, faultLauncherPath],
    executable: process.execPath,
  };
}

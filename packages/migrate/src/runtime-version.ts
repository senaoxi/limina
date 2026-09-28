import { createRequire } from 'node:module';
import pkg from '../package.json' with { type: 'json' };

export function assertRuntimeVersion(): void {
  const runtime = createRequire(import.meta.url)('limina/package.json') as {
    version?: string;
  };
  if (runtime.version !== pkg.version) {
    throw new Error(
      `limina-migrate@${pkg.version} requires limina@${pkg.version}; found ${runtime.version ?? 'an unknown version'}. Install matching versions before migrating.`,
    );
  }
}

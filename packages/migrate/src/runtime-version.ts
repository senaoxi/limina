import { createRequire } from 'node:module';
import package_ from '../package.json' with { type: 'json' };

export function assertRuntimeVersion(): void {
  const runtime = createRequire(import.meta.url)('limina/package.json') as {
    version?: string;
  };
  if (runtime.version !== package_.version) {
    throw new Error(
      `limina-migrate@${package_.version} requires limina@${package_.version}; found ${runtime.version ?? 'an unknown version'}. Install matching versions before migrating.`,
    );
  }
}

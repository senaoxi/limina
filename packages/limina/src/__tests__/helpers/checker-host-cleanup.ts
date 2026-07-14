import { afterEach } from 'vitest';
import { disposeCheckerProcessHostForTesting } from '../../typecheck/process-host';

// Specs that execute checker builds through the default runner (pipeline and
// CLI-level tests) create the shared checker host inside the vitest worker.
// Dispose it after every test so force-killed workers cannot leak host
// processes that hold inherited stdio pipes open.
afterEach(() => {
  disposeCheckerProcessHostForTesting();
});

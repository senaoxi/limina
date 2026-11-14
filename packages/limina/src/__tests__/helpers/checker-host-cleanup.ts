import { afterEach } from 'vitest';
import { disposeCheckerProcessHostForTesting } from '../../typecheck/process-host';

// Await any unfinished owned groups after an assertion interrupts a request.
afterEach(disposeCheckerProcessHostForTesting);

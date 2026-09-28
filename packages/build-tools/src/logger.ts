/**
 * Shared monorepo logger entry.
 *
 * Outside a host-managed build this module falls back to the generic
 * `logaria` runtime, so scripts and standalone utilities can use
 * the same import safely. Host integrations may alias this subpath to their
 * own scoped logger facade, such as `@docs-islands/vitepress/logger`, when
 * bundling code that must participate in a controlled logger scope.
 */
export { createLogger } from 'logaria';

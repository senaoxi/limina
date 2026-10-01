# Standalone migrate checkpoint — 2026-10-01

This is an implementation checkpoint for cloud continuation. It is not a release
approval or a claim that the final CI matrix is green.

- Clean-history baseline: `35e25e297c9d7e18ec3b569168428cea0697d697`.
- Both source versions remain `0.4.0`; choose an unpublished breaking release
  version before publication. Removing the published internal export is breaking.
- Migrate uses Limina only as a workspace development dependency. Its build embeds
  current core source, verifier and renderer. Published migrate has explicit
  picomatch/tinyglobby/oxc-resolver dependencies, required TypeScript and six
  optional capability peers, with no Limina dependency or public runtime API.
- Core keeps its source bridge and physical resources; publication removes only
  the internal export mapping. Persisted schema paths still belong to Limina.
- Embedded versions are checked against the installed migrate self manifest.
  Project-version metadata warnings are separate from input-verification results.
  Configs importing public Limina require a project installation.

The architecture and lifecycle owners and their complete Chinese counterparts
were updated together. See `.agents/docs/architecture.md`,
`.agents/docs/limina-lifecycle.md`, `.agents/docs/limina-invariants.md` and
`.agents/docs/migration.md` for the maintained contracts.

## Validation completed locally

On macOS arm64 with raw Node 24.21.0 and pnpm 11.9.0, using isolated dependencies:

- Frozen installation; private-tools and product build.
- Final `test:smoke`: four files, twelve tests, including migrate-only strict
  consumers, neutral config, public config import failure/success, public types,
  closed exports, missing TypeScript/tsx, version and worker failures.
- Final `lint:check`, `format:check`, `typecheck`, `check`, `lint:packages`,
  `docs:build`, `infrastructure:check` and `artifacts:report`.
- Extra real packed consumers on TypeScript 5.4.5, 5.9.3 and 6.0.3; native/tsx;
  separate Vue/Astro/Svelte config owners; fresh check/graph topology.
- Stale-dist/current-source proof, disabled source alias rejection, private
  external rejection and mismatched source-version rejection.
- Post-load embedded-version/chunk faults produce `inputConsumable=false`.
- Real PTY renderer: ready, closed, exit zero, stdout/stderr forwarding.
- Five tracked bilingual PCR pairs: heading topology and relative file links.
- Earlier full unit, integration and tooling runs passed before the final
  behavior-preserving lint refactors. Final unit rerun was deliberately interrupted
  for the user's network shutdown; final integration/tooling reruns had not started.

Lint has four length warnings and zero errors. No assertions, skips, governance
exceptions or timeout limits were relaxed. The existing Windows-only unit skip on
macOS was not added by this change.

## Continue in cloud

1. Verify the checkpoint and latest remote main descend from the clean baseline.
   Never merge old pre-cleanup history or push backup refs.
2. Reconcile the separately prepared Astro patch. Its clean local commit was
   `f550fbb6848407ab313c9c1ab9992082bae96b48`, parent equal to this baseline; obtain
   its verified remote location from the coordinating task. This checkpoint has
   not merged it. Resolve the `smoke/helpers.ts` overlap and synchronize migrate's
   Astro peer with the integrated core contract before rebuilding.
3. Use pnpm 11.9.0 and a separate store/cache, then run sequentially:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build:tools
   pnpm run build
   pnpm run test:unit
   pnpm run test:tooling
   pnpm run test:integration
   pnpm run test:smoke
   pnpm run typecheck
   pnpm run check
   pnpm run lint:packages
   pnpm run lint:check
   pnpm run format:check
   pnpm run docs:build
   pnpm run infrastructure:check
   pnpm run artifacts:report
   git diff --check
   ```

4. Native Windows/Linux and Node-floor acceptance, remote CI, approved release-tag
   validation, trusted publishing and docs deployment were not executed locally.
   Complete the applicable CI gates before merging under the new authorization.
   Do not publish npm packages or documentation as part of this continuation.

The supported baseline Astro semantic tuple requires check 0.9.10, language-server
2.16.13, compiler 2.13.1 and Volar 2.4.28. Unpinned upstream check dependencies now
resolve a newer unsupported language-server; this is accurately diagnosed by the
existing core ownership guard. Local positive acceptance used scoped fixture pins,
not a production dependency override or a widened compatibility predicate. Review
this existing limitation alongside the separate Astro patch.

Essential new files are `packages/migrate/src/build-info.ts`,
`packages/migrate/src/runtime-observation.ts` and
`smoke/migration-standalone.spec.ts`. All implementation, tests, build configs,
manifest/lock changes, generated license attribution and paired documentation are
in the checkpoint. Local paths, raw logs, dependency stores, fixtures and tarballs
are deliberately excluded from this handoff commit.

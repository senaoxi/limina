# Limina Repository Routes

Use this reference when locating document owners, establishing product evidence,
or selecting checks. Paths describe the inspected repository layout, not a support
contract. Recheck current files and manifests before use. Keep this skill at
`.agents/skills/doc-coauthoring/`; its repository-relative links depend on that location.

## Document destinations

- Public VitePress pages: `docs/en/<topic>.md` and `docs/zh/<topic>.md`, with
  configuration pages under the corresponding `config/` directory. Read both editions.
- Repository overview: `README.md` and `README.zh-CN.md`. Package overviews use the
  same pair under `packages/limina/` and `packages/migrate/`. Read the actual package
  manifest before describing an installation, executable, or published API.
- Contributor workflow: `CONTRIBUTING.md` and the
  [development workflow](../../../docs/development-workflow.md). Do not create an
  unrequested counterpart or duplicate the workflow in public product guides.
- PCR: `.agents/docs/<topic>.md` and `.agents/docs/zh/<topic>.md`. Locate the owner
  through the [PCR map](../../../docs/README.md); follow
  [project-context-writing](../../project-context-writing/SKILL.md). The two editions
  are one owner, not independent sources of truth.
- Proposals: revise an existing owner where appropriate. Follow `AGENTS.md` and the
  [architecture workflow](../../../docs/architecture-workflow.md) for contract changes;
  do not turn an unapproved proposal into a decision record or shipped documentation.

## Evidence entry points

Inspect the relevant implementation and tests, then follow imports as needed.
These are starting points, not a list of capabilities to copy into prose.

- CLI syntax and execution: `packages/limina/src/cli/`, including registration,
  argument parsing, validation, and dispatch. Check invalid input and forwarding
  boundaries rather than inferring behavior from command names or help text alone.
- Configuration: `packages/limina/src/config/`, including `schema.ts`, `schema/`,
  public types, loading, and runtime normalization. Follow the consuming implementation
  before claiming an option has an effect. Omitted, empty, and disabled values may differ.
- Architecture and graph semantics: start from the [Limina map](../../../docs/limina.md),
  then locate the relevant owner under `packages/limina/src/core/`, checker code,
  preflight code, and corresponding tests. Re-establish active capability boundaries.
- Migration: `packages/migrate/src/`, its tests, and `packages/migrate/package.json`.
  Keep consumer migration behavior separate from the
  [standalone repository migration record](../../../docs/migration.md) and its
  publication or deployment gates.
- Regression evidence: `packages/limina/src/__tests__/`,
  `packages/migrate/src/__tests__/`, relevant fixtures, and package scripts.
  Reading a test does not mean it passed in the current environment.
- Distribution and compatibility: root and owning-package manifests,
  `pnpm-workspace.yaml`, build configuration, and release-specific source when needed.
  Installed tools or current HEAD do not prove an npm release supports a feature.

Do not use an old `packages/limina/docs/` path or a remembered internal filename
without locating it in the current checkout. Avoid embedding versions or a second
capability inventory in this skill; those belong to the current implementation
and their existing documentation owners.

## Public routes and links

Read [VitePress configuration](../../../../docs/.vitepress/config.ts),
[English navigation](../../../../docs/en/config.ts), and
[Chinese navigation](../../../../docs/zh/config.ts) when changing page topology.

The inspected configuration rewrites `en/:rest*` to `:rest*`, uses English as the
root locale, and defines a `zh` locale. Do not invent `/en/` links from the source
directory name. Read the configured base and any build overrides rather than
hard-coding the deployed origin or assuming source and public paths coincide.

Check language switches, sidebar entries, incoming links, and translated heading
anchors. A source-relative link must resolve from its actual source file; a public
route must resolve after rewrites and base handling. Use durable repository links
for implementation references when no published documentation page owns the content.

## Validation routes

Read the [root manifest](../../../../package.json),
[docs manifest](../../../../docs/package.json), and
[acceptance procedure](../../../docs/development-workflow.md#validation-and-handoff)
before choosing commands. Use the pinned package manager and an existing compatible
installation. Do not install dependencies or weaken synchronization checks silently.

- Run `pnpm exec prettier --check <explicit-touched-files>` for scoped formatting
  when supported by the installed toolchain. Repository-wide `format:check` and
  `lint:check` are checks; `format:write` and `lint:fix` intentionally mutate files.
- For public site edits, run `pnpm run docs:build`. Its current script runs privacy
  checks before the VitePress build and against built output afterward. Report a
  build or scan failure; do not reinterpret local success as deployment approval.
- For PCR-only edits, use `pnpm run docs:privacy --context-records .agents/docs`,
  pair and link review, formatting, and Git checks. Do not require a full product
  build merely because prose changed; follow the owning procedure for other gates.
- For changed executable examples, establish the exact environment and use the
  relevant existing tests or a bounded reproduction under applicable verification
  instructions. A docs build alone does not establish command semantics.
- Inspect `git diff --check`, Git status, and the intended diff. Inspect untracked
  content separately; do not stage it just to make a diff command see it. Run
  broader gates only when the affected boundary or repository procedure requires them.

Treat privacy scans, reader reviews, runtime checks, and formatting as distinct
forms of evidence. Report which actually ran, their scope, failures, and remaining
limits. Never claim a fresh reader test, build, or runtime result that did not occur.

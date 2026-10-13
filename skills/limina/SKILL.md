---
name: limina
description: Configure, run, and troubleshoot Limina governance in TypeScript projects and workspaces. Use for limina.config files, Limina CLI commands, checker ownership, generated project graphs, source boundaries, managed outputs, package checks, or limina-migrate adoption. Exclude general TypeScript or bundler work that does not involve Limina.
license: MIT
---

# Limina

Help a project use Limina's existing contracts. Limina governs source ownership,
project relations, checker execution, and package artifacts. The project still
owns its production bundler, tests, and publication workflow.

## Establish the applicable implementation

Before recommending a config or command:

1. Read the project's instructions, manifest, package manager declaration and
   lockfile, existing Limina config, and relevant source `tsconfig` entries.
   Preserve unrelated changes and the project's chosen package manager.
2. Identify the locally resolved Limina version from `limina/package.json` and
   inspect its `engines` and `peerDependencies`. Use the project's local binary
   and its `--help`; do not assume a `--version` flag or install `latest` to
   investigate an existing installation.
3. For a Limina source checkout, trace the current source owners listed in
   [architecture.md](references/architecture.md#source-map). For an installed
   release, prefer its declarations, schema, help, and matching release source.
   The repository's latest branch may differ from that release. These references
   describe the accompanying implementation; when it differs from the target,
   adapt to the target and state the difference. Do not invent compatibility
   aliases or import `limina/internal/*` in a consumer project.

If required implementation evidence is unavailable, identify the uncertain claim
and use a minimal reproduction before presenting it as supported. Distinguish
source inspection, commands actually run, and checks still unexecuted.

## Choose the task

Read only the reference needed for the current task:

| Task                                                                  | Reference                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Initialize, select a command, query issues, or migrate                | [CLI workflows](references/cli.md)                         |
| Change config fields, checker scopes, pipelines, or caching           | [Configuration](references/config-schema.md)               |
| Explain ownership, source references, or artifact consumption         | [Architecture](references/architecture.md)                 |
| Validate built manifests, exports, runtime imports, or release inputs | [Package and release checks](references/package-checks.md) |
| Diagnose a failure and select a narrow repair                         | [Troubleshooting](references/troubleshooting.md)           |

## Start with the smallest applicable config

For an installation that supports the accompanying configuration contract:

```ts
// limina.config.mts
import { defineConfig } from 'limina';

export default defineConfig({});
```

Automatic checker discovery is enabled without an explicit checker declaration.
Add only the policy the project needs. Current governance selectors live under
`scope`; check settings such as `graph`, `source`, and `package` remain top-level.
See the configuration reference before adapting older examples.

The project still needs source tsconfig coverage. A TypeScript Limina config can
itself be in the source boundary; include it in an appropriate checker project
when reported as uncovered. An accepted minimal config does not imply a passing
default check.

The following commands assume an existing pnpm installation. Use the target
project's equivalent local runner for another package manager:

```sh
pnpm exec limina --help
pnpm exec limina check
pnpm exec limina check --issues --format json
```

`check` runs real checkers and can write generated configs, internal declarations,
and caches. `--issues` reads stored evidence; it does not rerun checks or prove
the current files pass. Inspect named pipeline commands before executing them.

For authorized first adoption, use `limina init` or `limina init --yes` in the
intended project. Init chooses the nearest `package.json`, writes adoption files,
and removes that root's existing `.limina` directory. It does not need a pnpm
workspace or install dependencies itself. `--yes` skips optional skill installation.
Review the resulting diff and follow the project's dependency installation rules.

## Preserve these distinctions

- Edit source configs and manifests. Regenerate `.limina` outputs through Limina;
  do not patch generated graph files or issue/cache snapshots.
- A manifest dependency authorizes a package import. The checker-resolved target
  determines source versus declaration/artifact consumption; `workspace:` alone
  does not determine a project-reference edge.
- Checker entry selectors match default `tsconfig.json` files. Named configs enter
  through supported solution references. Excluding a direct entry does not sever
  a reference closure that still reaches it.
- `checker build` produces internal declarations. `build <config>` uses managed
  artifact outputs. Neither substitutes for an arbitrary production bundle.
- `package check` and `release check` validate built outputs. They do not publish;
  skipped optional tools or unavailable evidence do not establish full coverage.
- Fix the cause of a failure. Do not broaden exclusions, add allowlists, disable
  checks, change peer ranges, or erase caches merely to obtain a green result.
  A policy change needs a reason grounded in the requested behavior.

## Complete the work

Make a focused change, run the relevant Limina command and required project checks,
and inspect the diff. Report the affected configuration or source boundary, the
observed result, and any skipped tool, unsupported environment, or unresolved
failure. Keep dependency upgrades, migration writes, and publication within the
user's actual scope; the skill itself grants no additional authorization.

# Troubleshooting

Preserve the first failing command, cwd, selected config, installed version, exit
status, and relevant diagnostic. Read the matching source owner from
[architecture.md](architecture.md#source-map) when help and the diagnostic are
insufficient. Run the narrow command that can distinguish competing explanations.

## Config and discovery failures

| Symptom                                                        | Investigation                                              | Focused response                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No Limina config found                                         | Inspect supported config names from cwd through ancestors  | Select the intended file with `--config`; use init only for authorized adoption    |
| Unexpected governance root                                     | Locate the nearest manifest above the selected config      | Choose the correct config anchor; do not add a fake workspace descriptor           |
| Invalid nearest manifest or conflicting manager                | Inspect that manifest, descriptor, and same-root lockfiles | Repair the actual metadata; do not escape to a parent root                         |
| Old `config`, `execution`, or checker `mode` rejected          | Compare with the target version's public schema            | Apply the domain mapping in [config-schema.md](config-schema.md)                   |
| `preset`, custom checker name, or named leaf selector rejected | Inspect `scope.checkers` and the selected entry            | Use fixed checker keys and default `tsconfig.json` entries                         |
| TypeScript config loading fails                                | Check Node support, module format, and installed loader    | Preserve the format; use supported `tsx` only if the native loader is insufficient |

Do not upgrade the package or rewrite project structure merely because this skill
describes a newer contract than the installed version.

## Graph, ownership, and coverage

| Symptom                                  | Evidence to inspect                                                          | Repair boundary                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Missing or conflicting checker ownership | Entry selectors, solution closure, framework files, connected build projects | Correct entry membership or the conflicting fixed assignment          |
| Excluded entry still appears             | References from another selected solution                                    | Decide whether to change membership or an actual region boundary      |
| Package import unauthorized              | Importing owner's dependency fields and any scoped root grant                | Declare the real dependency or correct the import                     |
| Cross-owner relative import              | Both package owners and the checker-resolved target                          | Use a valid package entry point where that is the intended dependency |
| Unexpected source/artifact relation      | Actual resolution, export conditions, managed-output attribution             | Correct the manifest or refs that contradict intended consumption     |
| Uncovered source                         | `scope.source`, checker-owned file sets, solution memberships                | Add valid coverage; use an allowlist only for a justified exception   |
| Already-covered allowlist entry          | Reported owner and exact allowlisted path                                    | Remove the obsolete exception                                         |
| Redundant implicit reference             | Inferred edge evidence versus `liminaOptions.implicitRefs`                   | Remove the duplicate; preserve only justified non-inferable relations |

Do not infer missing references from `workspace:` or from a filename alone.
Do not repair proof errors by widening exclusions or modifying generated configs.

## Checkers and builds

Missing peers require the supported dependency in the actual resolution scope,
not an arbitrary global install. Astro/Svelte peers and generated framework inputs
must be available at the owning leaf. Limina does not run framework sync commands;
inspect the project's generation workflow.

`checker typecheck` is a rerun of applicable framework leaves. A disabled result
with no targets is not proof that an expected framework project was discovered.
Verify entry membership when a target was expected.

If a user-facing artifact is absent after `checker build`, inspect whether the
project needs `build <config>` with `liminaOptions.outputs` or its production
bundler. For invalid generated declaration options, find the originating source
option or unsupported topology, fix it, then regenerate.

## Pipelines, issues, and cache

- A missing named pipeline never falls back to the default. Read `pipelines`
  before choosing a name; use `limina check` for the default plan.
- Extra arguments after a pipeline name, including `--`, are rejected. Put tool
  arguments in a command step's `args`; whitespace-split strings cannot preserve
  quoted arguments containing spaces.
- Read issue details with `check --issues`, keeping the reported invocation ID
  when investigating a standalone failure. Use `--format json` without `--limit`;
  a human-card limit is invalid for machine output.
- A pending, aborted, or unavailable latest attempt does not establish success.
  Compare inventory status and invocation identity before interpreting zero issues.
- A config-loading failure can occur before a tracked attempt starts, leaving
  older completed inventory visible. Compare its command/time with this run and
  retain the actual exit code and stderr. For completed runs, inspect `run.result`.
- `cache: { dependencies: [] }` is valid; `cache: {}` is not. Declare exact files
  read outside module loading relative to the selected config file.
- Use `check --force` for a cold-analysis comparison when needed. It does not
  force compiler rebuilds, enable writes under `cache: false`, or combine with
  `--issues`. Preserve evidence before changing cache state; do not patch snapshots.

## Package and release failures

Read [package-checks.md](package-checks.md) for selection and tool coverage.
Check the configured output directory, generated manifest, and packed contents.
Fix build/package generation and rebuild rather than deleting required artifacts
or changing check policy to silence the finding.

Keep a bounded diagnosis: state the cause supported by evidence, the repair, the
rerun result, and what remains untested. Do not present a source-only hypothesis,
a skipped tool, or old stored inventory as a completed validation.

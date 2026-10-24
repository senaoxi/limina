# Repository gates

[English](./gates.md) | [简体中文](./zh/gates.md)

The private [`@limina/gates`](../../packages/gates/package.json) workspace owns executable repository governance: license policy and dependency-review consistency, bundled-license evidence, commit conventions, documentation privacy, release admission/publication checks and ESLint rules. Keep repository detection modules here; root scripts, hooks and configuration are integration entries. Product graph/source/proof/package detectors retain their product owners.

## Ownership and bootstrap

The [license data](./license-policy.md) has one Markdown owner. [Marked parsing](../../packages/gates/src/licenses.ts) is shared by the build-time [bundle guard](../../packages/gates/src/license-policy.ts) and [configuration comparison](../../packages/gates/src/repo.ts); YAML parsing uses the existing `yaml` package. The staged checker parses index content directly rather than importing a cached working-tree list.

The [commit rules](../../packages/gates/src/commit/config.mjs), [message entry](../../packages/gates/src/commit/message.ts), [privacy scanner](../../packages/gates/src/privacy/index.ts), [release modules](../../packages/gates/src/release/release.ts) and [ESLint configuration](../../packages/gates/src/eslint/general.ts) live in the same private package. Third-party engines, catalogs and release-age/security controls retain their existing versions and authority. External service checks and audit/report steps remain in their owning workflows.

`build:tools` compiles gates before build tools, independently of the Limina product. Build tools consume the license guard through the gates export; gates do not depend on build tools or either product. The package is excluded from the public release group and published product manifests. Commit and privacy entries use Node's native TypeScript support and run after dependency installation without requiring generated `dist` files. Release/ESLint exports use compiled output.

The gates TypeScript scopes use the same build checker as their typed consumers in root/build tooling. Consolidation creates declaration relations across these scopes; one internal declaration component must have one checker owner. Keep this relation intact when changing checker routing rather than bypassing graph validation.

## ESLint structure policy

The [root flat config](../../eslint.config.mjs) composes the compiled shared [general configuration](../../packages/gates/src/eslint/general.ts), explicit [root presets](../../packages/gates/src/eslint/presets/root.ts), and repository overrides in order. Both product `src/**/*.ts` trees, including declaration files, explicitly turn off `complexity`, `max-depth`, `max-lines`, `max-lines-per-function` and `max-params`. Local types, natural parameters and cohesive state branches must not require forwarding files or parameter bundles solely to meet a numeric budget. There are no per-file product budget exceptions.

The repository test override runs after the script/tooling overrides, preserving the shared test rules and portable-path assertion guard even when a tooling test also matches a script glob. Script and tooling warning budgets retain their existing scopes and exclude blank/comment-only lines where configured; they do not become product source limits. The current [lint pipeline](../../limina.config.mts) passes the explicit root config and does not set `--max-warnings`; changing invocation warning policy requires reviewing these scopes again. Existing fixture and generated-output ignores retain their separate authority.

Shared configuration still owns unused-code, type-import, error and stale-disable checks within their configured scopes; the [portable-path plugin](../../packages/gates/src/eslint/plugins/portable-path-plugin/rules/portable-path-comparison-rule.ts) owns test path comparisons. This policy does not enable a new type-aware preset. Package import authorization remains with [source checking](../../packages/limina/src/source-check/source-import-validation.ts), runtime relative-import cycles and scheduler/materialization capability restrictions with [architecture guards](../../packages/limina/src/__tests__/architecture-boundaries.spec.ts), and workspace-only export removal with the [publication hook](../../packages/limina/packagePlugin.ts). Size rules do not substitute for those checks.

After changing the configuration chain, follow [current-source bootstrap and acceptance](./development-workflow.md#setup-and-builds). Inspect representative final per-file configurations and run allowed/rejected lint examples; configuration calculation alone does not establish a passing lint run.

## Commit and CI entry points

| Entry                                                         | Reviewed input and behavior                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run gates:check`                                        | Checks the working-tree Markdown policy and dependency-review YAML; required by the CI quality action.                                |
| `pnpm run gates:staged` / tracked `pre-commit`                | Reads both files from Git's index, requires equal license sets, and runs `git diff --cached --check`. Missing or invalid inputs fail. |
| `pnpm run commit:check <message-file>` / tracked `commit-msg` | Applies the existing commitlint convention and Git cleanup semantics without rewriting the message.                                   |
| `pnpm run docs:privacy`                                       | Runs the existing documentation scanner; `--built` and `--context-records` retain their scopes.                                       |
| `pnpm run release:check-tag`                                  | Applies tag/source-group/checkout/main-ancestry guards through the release entry.                                                     |

Unstaged fixes cannot make an invalid staged policy pass; reordered equal lists can pass. The checks do not stage files, change HEAD, repair configuration or require an initial commit. Linked worktrees and `GIT_INDEX_FILE` use Git's own index selection. Husky installation and explicit `HUSKY=0`/Git hook bypass behavior remain native; CI runs the working-tree gate independently of local hooks.

Commit readability is part of the [commit convention](../../.github/commit-convention.md#subject-and-body). The shared commitlint rules bound every body and footer line, including bullet prefixes, the first `BREAKING CHANGE: ` line and footer continuations. Raw-line checks prevent URL exemptions or parser classification of issue references from bypassing the limit. Authors shorten or split body details and wrap footer prose at word boundaries; the validator rejects overlong lines without rewriting them. The [Git hook tests](../../scripts/git/hooks.spec.ts) cover accepted/rejected boundaries, Unicode and CRLF input, URL/reference cases and a real rejected commit that preserves HEAD and the index.

These are mechanical checks. [Dependency admission](./dependency-admission.md), license obligations, semantic review and [final acceptance](./development-workflow.md#validation-and-handoff) still apply before handoff or an authorized commit.

## Regression owners

The [staged-gate tests](../../packages/gates/src/commit/staged.spec.ts) exercise real rejected/accepted Git commits, index authority, malformed inputs and unchanged HEAD/index/worktree. Existing [Git hook](../../scripts/git/hooks.spec.ts), [release](../../scripts/release/publication.spec.ts), [tag CLI](../../scripts/release/check-tag-cli.spec.ts), [workflow](../../scripts/release/workflow.spec.ts) and [privacy](../../scripts/docs/privacy.spec.ts) tests retain their process and integration boundaries while using the package. The package's ESLint tests retain the existing parser/rule regressions. The [root configuration suite](../../packages/gates/src/eslint/__tests__/root-config.spec.ts) uses the actual root config to cover cohesive product code, script/test override order, correctness checks, portable paths and existing exclusions. Root `test:tooling` executes these groups.

Fixture repositories ignore installed `node_modules` before staging their baseline. Git can traverse Windows directory junctions as dependency files, while POSIX directory symlinks can themselves enter the index. The staged-gate regression checks that Git's actual index contains no runtime dependencies, so commits exercise only owned fixture inputs. The real hook and staged whitespace check remain active.

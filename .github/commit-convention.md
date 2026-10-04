# Git Commit Message Convention

> This is adapted from [Angular's commit convention](https://github.com/conventional-changelog/conventional-changelog/tree/master/packages/conventional-changelog-angular).

Use this convention for commit messages and PR titles. The title rules apply to both; body and footer formatting applies to commit messages. Use the rules and examples below directly; do not read Git history to infer commit style.

Before drafting, inspect the intended diff. Before an authorized commit, verify that the complete `git diff --cached` matches the intended change and contains no unrelated work.

## Header format

Ordinary titles must match the following header pattern. Generated release messages are the tooling-specific exception described below.

<!-- prettier-ignore -->
```js
/^(revert: )?(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?: .{1,50}/
```

## Type and scope

Use `type(scope)!: subject`, omitting `(scope)` when it adds no useful boundary and `!` when the change is not breaking. Choose the type by the purpose of the change, not merely by the files touched:

- `feat`: add a capability or observable behavior; `fix`: correct faulty behavior; `perf`: improve performance without changing the supported contract.
- `refactor`: restructure implementation without changing observable behavior. Do not hide a behavior fix under this type.
- `docs`: change documentation, explanations or agent guidance. Documentation-site functionality can instead be `feat(docs)` or `fix(docs)`.
- `test`: change only tests, fixtures or test infrastructure. Regression tests accompanying a production fix belong with the `fix` commit.
- `build`: change build tooling, bundling or dependency/peer configuration; `ci`: change CI workflows or automation. A release-script bug is `fix(release)`, while publication workflow changes can be `ci(release)`.
- `style`: formatting-only changes, not visual/UI features; `chore`: other repository maintenance that does not fit a more specific type. Neither is a catch-all for product changes.

Use a short, stable subsystem scope when it helps: existing examples include `migrate`, `checker`, `release`, `docs`, `home`, `deps` and `eslint-config`. These are examples, not an allowlist. Omit the scope for cross-cutting work; do not use `limina` as a universal scope merely because imported monorepo history does. Prefer one cohesive purpose per commit; a scope-less title is not a reason to bundle unrelated changes.

## Subject and body

Write the subject in English with an imperative, present-tense verb, a lowercase first letter and no final period. Name the action and its concrete target or behavior, such as `preserve healthy sources` or `wait for uploaded npm version metadata`, rather than `update code`, `fix issues` or a list of edited files. Preserve the casing of identifiers such as `TypeScript`, `typeRoots` and `@astrojs/check`.

For new ordinary titles, keep the subject to 1–50 characters, excluding the type, scope and breaking marker; move additional detail into the body. Check the length explicitly: the convention's regex is not end-anchored, so a successful prefix match alone does not prove this limit. Historical longer subjects are not templates for new messages.

A focused change may need only a title. For nontrivial work, write an English body explaining the reason, behavior change and important preserved constraints. The changelog generator uses commit titles, so the subject must stand on its own.

Format ordinary body details as follows:

- Leave exactly one blank line after the title. Write each detail on its own line beginning with `- ` (a hyphen and one space); keep the items consecutive without blank lines between them.
- Start each item with a lowercase imperative, present-tense verb such as `add`, `preserve`, `reject`, `cover` or `document`. Preserve identifier casing and omit a final period.
- Keep one concrete point per item. Do not use paragraphs, headings, numbered lists, `*` bullets or nested lists for ordinary details. Keep each item on one physical line rather than adding unprefixed continuation lines; the subject's 50-character limit does not apply to body lines.
- Describe the actual diff rather than repeating a file inventory or pasting task transcripts. Mention validation only when it was actually executed, and do not claim outcomes the diff and checks do not establish.

Example of a title with a body:

```text
fix(migrate): preserve healthy sources and native relations

- retain source identity when configuration analysis fails
- preserve native references that cannot be inferred
- cover incomplete analysis with regression tests
```

## Breaking changes

Mark an actual compatibility break with `!` before the colon, and add a `BREAKING CHANGE:` footer. Internal file moves or large diffs alone do not justify the marker. Use this footer layout:

- Leave exactly one blank line between the body and footer, or between the title and footer when there is no body. Start the footer at the beginning of the line with the exact uppercase, singular token `BREAKING CHANGE: `, including the space after the colon. Do not prefix it with `- ` or use `Breaking changes:`, `BREAKING CHANGES:` or a Markdown heading.
- Start the description after the token in lowercase, preserving identifier casing. State the incompatible behavior and affected API, CLI option, configuration or default, then explain the concrete migration action. Do not write only `breaking changes` or `update configuration` without identifying what changed and what replaces it.
- Use normal sentence punctuation in the footer, with capitalized subsequent sentences. Long explanations may continue on plain, unprefixed lines; these continuation lines belong to the footer and are the exception to the ordinary body's `- ` rule. Keep the incompatibility and migration explanation together without an intervening blank line.

Example of a breaking change with a body and footer:

```text
feat(checker)!: require explicit checker identities

- replace checker aliases with fixed checker names
- update configuration diagnostics and migration guidance

BREAKING CHANGE: config.checkers no longer accepts checker aliases or the
preset field. Replace alias entries with supported checker-name keys.
```

Examples illustrate message layout; include only details supported by the actual change and its validation.

## Reverts and release messages

- For a revert, use `revert: <original commit header>` as required by the convention, and identify the reverted commit and reason in the body using the same `- ` format. Do not substitute `revert(scope): ...`.
- The release tool generates `release: limina@<version>, migrate@<version>` in `scripts/release/release.ts`. This is a tooling-specific exception, not an additional type for ordinary hand-written commits or release-maintenance work. Preserve generated release messages and imported historical messages; do not rewrite history to normalize them.

Examples of ordinary titles:

```text
fix(migrate): preserve healthy sources and native relations
fix(release): wait for uploaded npm version metadata
ci(release): bootstrap private tools before checking tags
build(checker): allow the @astrojs/check 0.9 peer range
feat(docs): unify article reading theme
test: canonicalize import analysis fixture roots
docs: clarify commit message conventions
```

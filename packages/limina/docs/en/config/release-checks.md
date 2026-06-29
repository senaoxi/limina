# Release Checks

`limina release check` is separate from `package check`. It uses the same `package.entries` selection, packs the npm tarball, and verifies publish hygiene plus workspace publish-dependency consistency against npm registry content.

For workspace publish dependencies, Limina compares the local packed package output with an npm dist-tag baseline (`release.contentHash.baselineTag`, defaulting to `latest`) by package-relative content diffs. Diff reports classify files as `changed`, `local-only`, or `remote-only`, and failures list the release-relevant file names. If the consumer-visible package content matches after configured ignores, the dependency does not need a new publish.

::: warning Tarball and publish hygiene
Release checks reject private outputs (`private: true`), missing `README.md` or `LICENSE.md`, source map files (`.map`), JavaScript `sourceMappingURL` directives, and publish dependency ranges that do not cover local workspace versions.
:::

::: warning Local dependency leaks
Release checks reject `workspace:`, `link:`, `file:`, and `catalog:` leaks from all dependency sections in both output and packed manifests.
:::

::: tip Selecting entries
Without `--package`, `limina release check` requires the nearest cwd `package.json#name` to match a configured entry. Pass `--package <name>` one or more times to skip cwd matching.
:::

## contentHash.baselineTag

- **Type:** `string | ((args: { importerName: string; dependencyName: string }) => string)`
- **Default:** `'latest'`

`contentHash.baselineTag` is the npm dist-tag used as the online baseline when comparing dependency package output. Pass a function to choose a different baseline per importer/dependency pair.

## contentHash.builtinIgnore

- **Type:** `boolean`
- **Default:** `false`

By default `contentHash.builtinIgnore` is `false`, so README/changelog/contributing/security files plus `docs/**` and `examples/**` are not ignored.

Set `builtinIgnore: true` to use that built-in ignore set only as a fallback when `release.contentHash.ignore` is omitted or an ignore function returns `undefined`.

::: info
An ignore function returning `[]` means that dependency ignores no files (the built-in set is not applied). Returning `undefined` is what falls back to the built-in set.
:::

## contentHash.ignore

- **Type:** `string[] | ((args: { importerName: string; dependencyName: string }) => string[] | undefined)`

`contentHash.ignore` can be a package-relative glob array such as `client/**` or `dist/*.wasm`, or a function that receives the importer and dependency package names and returns a glob array.

Ignored reports are grouped by the matching rule and show counts for `changed`, `local-only`, and `remote-only`.

::: info `[]` vs `undefined`
For the function form, returning `[]` ignores nothing for that dependency, while returning `undefined` falls back to the built-in ignore set when `builtinIgnore: true`.
:::

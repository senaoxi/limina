# Release Checks

`limina release check` is separate from `package check`. It uses the same `package.entries` selection, packs the `npm tarball`, and verifies publish hygiene plus workspace publish-dependency consistency against `npm` registry content.

Limina's built-in release checks always run. The optional `release.npmPackageJsonLint` integration can additionally lint the packed `package.json` with `npm-package-json-lint`.

For workspace publish dependencies, Limina compares the local packed package output with an `npm dist-tag` baseline (`release.contentHash.baselineTag`, defaulting to `latest`) by package-relative content diffs. Diff reports classify files as `changed`, `local-only`, or `remote-only`, and failures list the release-relevant file names. If the consumer-visible package content matches after configured ignores, the dependency does not need a new publish.

Before unpacking or comparing a registry baseline tarball, Limina verifies it against `dist.integrity`. If that field is absent, Limina verifies the SHA-1 `dist.shasum` fallback. Missing, malformed, or mismatched integrity metadata fails `release check`; this verification cannot be skipped.

::: warning Tarball and publish hygiene
Release checks reject private outputs (`private: true`), missing `README.md` or `LICENSE.md`, source map files (`.map`), `JavaScript sourceMappingURL` directives, and publish dependency ranges that do not cover local workspace versions.
:::

::: warning Local dependency leaks
Release checks reject `workspace:`, `link:`, `file:`, and `catalog:` leaks from all dependency sections in both output and packed manifests.
:::

::: tip Selecting entries
Without `--package`, `limina release check` requires the nearest cwd `package.json#name` to match a configured entry. Pass `--package <name>` one or more times to skip cwd matching.
:::

## npmPackageJsonLint

- **Type:** `boolean | { rules?: Record<string, RuleConfig> }`
- **Default:** `false`

`npmPackageJsonLint: true` enables `npm-package-json-lint` for the packed publish manifest with Limina's default release rules. The object form also enables the integration and merges `rules` over those defaults. Set an individual rule to `off` to disable it, or use `warning` when the finding should be shown without failing the release check.

`RuleConfig` is `off`, `warning`, `error`, or a `[severity, options]` tuple accepted by the selected rule.

```ts
export default defineConfig({
  release: {
    npmPackageJsonLint: {
      rules: {
        'prefer-property-order': 'warning',
        'require-types': 'off',
      },
    },
  },
});
```

`npm-package-json-lint` is an optional peer dependency of Limina. Install it in the workspace that runs the enabled integration:

```sh
pnpm add -D npm-package-json-lint@^9.1.0
```

If the integration is enabled but the package is not installed, `release check` fails with an installation hint. Omit the field or set it to `false` when the workspace does not want this integration. Limina reads rule overrides directly from this field and does not search for a separate `npm-package-json-lint` config file.

## contentHash.baselineTag

- **Type:** `string | ((args: { importerName: string; dependencyName: string }) => string)`
- **Default:** `'latest'`

`contentHash.baselineTag` is the `npm dist-tag` used as the online baseline when comparing dependency package output. Pass a function to choose a different baseline per importer/dependency pair.

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

`contentHash.ignore` can be a package-relative `glob` array such as `client/**` or `dist/*.wasm`, or a function that receives the importer and dependency package names and returns a `glob` array.

Ignored reports are grouped by the matching rule and show counts for `changed`, `local-only`, and `remote-only`.

::: info `[]` vs `undefined`
For the function form, returning `[]` ignores nothing for that dependency, while returning `undefined` falls back to the built-in ignore set when `builtinIgnore: true`.
:::

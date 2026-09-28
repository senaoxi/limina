# Release Checks

`limina release check` is separate from `package check`. It uses the same `package.entries` selection, packs the `npm tarball`, and verifies publish hygiene plus workspace publish-dependency consistency against `npm` registry content.

Limina's built-in release checks always run. The optional `release.npmPackageJsonLint` integration can additionally lint the packed `package.json` with `npm-package-json-lint`.

For workspace publish dependencies, Limina compares the local packed package output with an `npm dist-tag` baseline (`release.contentHash.baselineTag`, defaulting to `latest`) by package-relative content diffs. Diff reports classify files as `changed`, `local-only`, or `remote-only`, and failures list the release-relevant file names. If the consumer-visible package content matches after configured ignores, the dependency does not need a new publish.

Before unpacking or comparing a registry baseline tarball, Limina verifies it against `dist.integrity`. If that field is absent, Limina verifies the SHA-1 `dist.shasum` fallback. Missing, malformed, or mismatched integrity metadata fails `release check`; this verification cannot be skipped.

::: warning Tarball and publish hygiene
Release checks reject private outputs (`private: true`), missing `README.md` or `LICENSE.md`, source map files (`.map`), `JavaScript sourceMappingURL` directives, and publish dependency ranges that do not cover local workspace versions.
:::

Dependency ranges use ordinary semver prerelease rules: `^1.0.0` does not accept `1.1.0-beta.1`, while `^1.1.0-beta.0` explicitly accepts that prerelease series. This applies to `dependencies`, `optionalDependencies` and `peerDependencies`; local workspace membership does not widen the packed consumer range.

The source map directive check uses JavaScript parser context to inspect actual line and block comments, including comments around template interpolation and regular expressions. Directive-like text inside a string, template literal or regular expression does not count. JavaScript that cannot be parsed reliably fails the release check with the affected file and parser diagnostic.

::: warning Local dependency leaks
Release checks reject `workspace:`, `link:`, `file:`, and `catalog:` leaks from all dependency sections in both output and packed manifests.
:::

::: tip Selecting entries
Without `--package`, `limina release check` requires the nearest cwd `package.json#name` to match a configured entry. Pass `--package <name>` one or more times to skip cwd matching.
:::

## Registry authority and response limits

Release registry requests must belong to the current effective registry authority; the default authority is the official npm registry (`https://registry.npmjs.org/`). Enterprise and mirror registries are supported when their metadata and tarballs use the same HTTPS origin.

Limina snapshots registry configuration once per release invocation, using the command's effective working directory to locate the npm project or workspace `.npmrc`. It does not read configuration from the output directory being compared. For each key, environment variables take precedence over project, user, then global npmrc files. Both uppercase and lowercase npm configuration environment variables are recognized; lowercase wins when both spellings exist. `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` select the corresponding files. npm's `ini` parser handles npmrc quoting and comments, and registry settings support `${ENV_VAR}` substitution. Missing substitution variables, unreadable configuration, missing explicitly selected config files, and invalid selected registry URLs fail the check.

After merging keys, a dependency's `@scope:registry` takes precedence over the general `registry` key. A general `NPM_CONFIG_REGISTRY` therefore does not replace a distinct scoped registry setting. If neither key exists, Limina uses the official npm default. Registry path prefixes are preserved, for example `https://packages.example.com/npm/team/`.

```ini
registry=https://packages.example.com/npm/default/
@team:registry=https://packages.example.com/npm/team/
```

Production registry and tarball URLs must be absolute HTTPS URLs without credentials, query strings, or fragments. Tarballs must have the same origin (scheme, host, and effective port) as the selected registry. Explicitly configured internal HTTPS registries are trusted authorities. Both metadata and tarball requests reject every redirect, including same-origin redirects. Cross-origin CDN tarballs, signed query URLs, and HTTP registries are outside the supported boundary. This registry selection support does not add npmrc authentication, custom CA, or proxy configuration support.

Metadata responses are limited to **16 MiB** and tarball responses to **128 MiB**. Limina checks `Content-Length` when valid, counts the actual response stream bytes after HTTP content decoding, and cancels oversized responses before parsing or integrity checking. Limits also apply to chunked and HTTP-compressed responses; responses exactly at the limit remain accepted. Timeouts and tarball integrity verification remain in effect. `LIMINA_RELEASE_REGISTRY` reports invalid authority, disallowed tarball URL, and oversized metadata/tarball reasons, with the byte limit and observed byte count when available.

These caps bound downloaded response bodies, not the expanded contents of a tar archive or total process memory. A tarball inside the download limit can still have a large decompressed archive.

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

Each importer → dependency edge evaluates its own baseline and ignore policy, including shared dependencies reached through several importers. Package visitation only limits recursive traversal; it does not reuse the first importer’s policy result for later edges.

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

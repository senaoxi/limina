# Package and release checks

Read this for publishable output validation. Establish which configured package
entry and built directory the user intends to check before running commands.
These checks do not replace the project build or perform publication.

## Configure the built surface

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/sdk',
        outDir: 'packages/sdk/dist',
        checks: ['publint', 'attw', 'boundary'],
        attw: { profile: 'esm-only' },
        boundary: { environment: 'browser' },
      },
    ],
  },
});
```

This example assumes an ESM-only browser package at that output path. Choose the
profile and environment from the actual consumer contract. `outDir` resolves from
the governance root and must contain the built package manifest and referenced
files; it is not merely a compiler output directory. `package.entries` also
participates in artifact attribution outside package-check execution.

Use the project's existing build, then check the selected outputs:

```sh
pnpm run build
pnpm exec limina package check --package @acme/sdk
pnpm exec limina release check --package @acme/sdk
```

Do not run an uninspected build/release script just because it has a familiar name.
Check generation rules and rebuild to repair missing or invalid output. Hand
editing `dist/package.json` would leave the next build broken.

## What each layer establishes

| Layer                 | Evidence                                                              | Important limit                                              |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Built manifest checks | Package shape, supported dependency declarations, output metadata     | Source manifest and built manifest serve different consumers |
| `publint`             | Published entry-point and package-format diagnostics                  | Optional tool can be skipped if unavailable                  |
| `attw`                | Type/runtime resolution consistency across selected consumer profiles | Missing optional tool or ignored rules reduce coverage       |
| `boundary`            | Emitted runtime import boundaries and allowed package access          | Does not prove all dynamic runtime behavior                  |
| Release checks        | Publishability, packed contents, dependency/release consistency       | Can require manager and registry access; does not publish    |

The default selected tools are `publint`, `attw`, and `boundary`.
`checks` chooses tools; explicit `publint`/`attw` settings can enable or disable
their tool. `--tool` narrows the configured selection rather than enabling a
disabled check. Filtering out every configured check is an error. Selecting only
unavailable optional tools can instead finish with skips and exit zero; that does
not establish tool coverage. Read individual statuses before reporting success.

`publint` supports `level` (`suggestion`, `warning`, `error`) and `strict`.
ATTW profiles are `strict`, `node16`, and `esm-only`; `--attw-profile` overrides one
invocation. Its entrypoint filters and ignored rules belong in the current public
ATTW config shape. An ignore is a deliberate contract exception, not a repair for
misaligned exports or missing declarations.

Boundary environment may be a string or a function of the output-relative file
path. Inspect the actual `browser`/`node` distinction before permitting Node
builtins or external packages. Do not hide missing runtime dependencies with
`ignoredExternalPackages`.

## Select entries explicitly when cwd is ambiguous

`--package` matches configured entry names and rejects unknown ones; it may be
repeated. Without it, selection considers the activated cwd package. Package
checks can fall back to all configured entries when no entry matches; release
checks require a valid cwd match. Prefer an explicit package for targeted work,
and inspect the reported selected entries.

## Release readiness

Release validation checks the publishable tarball surface as well as local
dependency consistency. Examples include private output manifests, missing
README/license content, local dependency protocols, source-map files or directives,
and mismatches with dependency versions/content. Follow the actual finding and
repair the packaging generator or release configuration.

`release.contentHash` configures baseline tags and ignored content for comparisons;
`release.npmPackageJsonLint` configures packed-manifest rules. Consult their current
types before overriding defaults. A registry/network failure or unsupported
manager-specific capability leaves that check incomplete; do not replace its
evidence with a guessed package version or a green local graph check.

Report checks run, checks skipped, affected output entries, and remaining consumer
or platform coverage. Publishing, tagging, pushing, and changing registry state
remain separate actions governed by the user's request and project workflow.

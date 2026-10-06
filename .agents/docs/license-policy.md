# Dependency license policy

[English](./license-policy.md) | [简体中文](./zh/license-policy.md)

This page owns the supported license list shared by [dependency admission][dependency-admission] and the [bundled-code license gate][license-loader]. Both language editions refer to the same data block below; maintain the list only here.

## Supported licenses

<!-- prettier-ignore -->
```json
[
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MPL-2.0"
]
```

## Maintenance and scope

Keep exactly one top-level fenced code block with the `json` language tag. Its value must be a non-empty array of unique, non-empty license strings without surrounding whitespace. The loader reads it relative to its module when imported, from either source or compiled gates, independently of the working directory. Missing files, missing or multiple JSON blocks, invalid JSON and invalid list values stop loading; there is no fallback list. Start a new build process after changing the list.

[Marked's public Lexer API][marked-lexer] parses Markdown into tokens; the loader selects top-level `code` tokens tagged `json` and passes their text to Node's JSON parser. Markdown fence forms and line endings follow Marked's grammar. Blocks nested in blockquotes or lists, and fence-looking text inside other code blocks, do not supply policy data. No Markdown parsing rules or HTML rendering are implemented locally.

The bundle gate matches license metadata exactly against this list; it does not interpret multiple-license expressions. Membership does not waive attribution, notices, redistribution obligations or the explicit review required for non-permissive licenses under [dependency admission][dependency-admission]. The [repository gate](./gates.md) requires the separate [GitHub dependency-review configuration][dependency-review] to contain exactly the same set: pre-commit reads both staged files, and CI checks the working tree. It rejects drift and invalid data rather than relying on comments or rewriting files.

The [release tooling tests][license-tests] exercise list changes and malformed policy data through the compiled module, together with the existing missing, conflicting and prohibited bundled-license checks.

## Parser dependency

`marked` 18.0.14 is a private gates development dependency, pinned in the [catalog][catalog] and [lockfile][lockfile]. The 2026-10-06 admission review found matching MIT licenses in the [registry metadata][marked-registry], tagged source and published package, no registry deprecation, no runtime dependencies or installation scripts, and a Node `>=20` requirement compatible with the repository floor. The [release][marked-release] was published on 2026-09-22 and meets the existing release-age rule. The tarball passed SHA-512 integrity validation; an isolated `npm audit` returned zero vulnerabilities, and `npm audit signatures` verified its registry signature and provenance attestation. Parsing uses only the published ESM entry and bundled type declarations; the package does not enter either product artifact.

VitePress already bundles a Markdown renderer for documentation, but reusing it here would couple the synchronous license loader to the documentation toolchain and asynchronous renderer initialization. [Prettier's public API][prettier-api] serves formatting rather than the required standalone Markdown token stream. [markdown-it][markdown-it] 15.0.2 is a suitable independent parser, but adds six runtime dependencies; Marked supplies the needed tokens without that graph. Existing admission, trust, release-age and audit controls remain in effect.

[dependency-admission]: ./dependency-admission.md#license-compatibility
[license-loader]: ../../packages/gates/src/license-policy.ts
[markdown-it]: https://github.com/markdown-it/markdown-it
[dependency-review]: ../../.github/dependency-review-config.yml
[license-tests]: ../../scripts/release/publication.spec.ts
[marked-lexer]: https://marked.js.org/using_pro#lexer
[catalog]: ../../pnpm-workspace.yaml
[lockfile]: ../../pnpm-lock.yaml
[marked-registry]: https://registry.npmjs.org/marked/18.0.14
[marked-release]: https://github.com/markedjs/marked/releases/tag/v18.0.14
[prettier-api]: https://prettier.io/docs/api

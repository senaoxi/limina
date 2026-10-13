# limina-migrate

Migrate existing TypeScript configuration into input that Limina can consume.

```sh
pnpm exec limina-migrate
# Or run the version matching your Limina installation:
pnpm dlx limina-migrate@<version>
```

No pre-existing Limina config is required. Discovery uses explicit `--config`, then the first default-named config found by searching all ancestors of cwd, then the nearest `package.json` only if no config exists. A selected config binds its own nearest manifest; a closer child manifest does not truncate config discovery. Invalid explicit paths or nearest manifests stop the command.

Flow displays cwd, governance root, manifest, root kind and config source before user config evaluation. The scope prompt defaults to Yes. Non-TTY execution requires `--yes`; this accepts only the scope and never approves dirty-worktree or hardlink writes. Confirmation input drift stops execution.

```sh
pnpm exec limina-migrate --dry-run --yes
pnpm exec limina-migrate --yes
```

Both modes display the complete file operation list derived from frozen patches, including schema, references, implicitRefs, outputs and exact exclusions. Normal execution writes only an authorized subset of that plan. Defaults remain in memory unless isolation requires `scope.regions.exclude`; then the plan creates a minimal static `limina.config.mjs` beside the root manifest. It never creates an empty config, performs init, or changes dependencies/scripts.

`--dry-run` produces a Preview without migration-controlled creates/updates, transaction artifacts, graph/cache publication, audit publication (including failure reports), or post-write verification. It needs no Git worktree or write authorization. Complete plans with governed sources return zero; incomplete or failed plans return nonzero. User config modules and existing third-party entrypoints can execute code: preview is not a JavaScript side-effect sandbox. Each later invocation replans independently.

The command also supports `--config`, `--config-loader native|tsx` and `--mode`. Configuration functions still receive `command: 'migration'`.

This CLI embeds the required core implementation from the same Limina release and has no runtime dependency on `limina`. Defaults and neutral configs can be migrated with only this tool and its required TypeScript peer. Configs importing public `limina` still require the main package in the project. Enabled optional loaders/checkers require their supported peers. It preserves migration's existing prompts, transaction recovery and fresh-process input verification. Applied success means the embedded normal check/graph input readers consumed the disk configuration, not that the project’s installed Limina runtime or full checks ran. The CLI reports project version observations separately; mismatched tool build/self versions fail before writes. Persisted schema paths stay in `node_modules/limina/schemas`; editor resolution requires the main package. For defaults without a created config, fresh workers reread manifest/workspace/tsconfig using the default input factory. If a config is created, workers load that real file. This is input validation under defaults, not config-free ordinary `limina check`. Successful migration does not replace `limina check`. It does not install project or framework dependencies.

`limina migration` remains a deprecated forwarding command. It uses a locally available matching migration package or downloads that exact version through npm. Install `limina-migrate` locally to use the forwarding command offline.

The package provides a CLI, not a public JavaScript migration API. See the [migration contract](../../docs/en/cli.md#limina-migration) for behavior and limitations.

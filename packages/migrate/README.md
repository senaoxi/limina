# limina-migrate

Migrate existing TypeScript configuration into input that Limina can consume.

```sh
pnpm exec limina-migrate
# Or run the version matching your Limina installation:
pnpm dlx limina-migrate@<version>
```

Use a Limina configuration: initialize the usual setup with `pnpm exec limina init`, or supply a neutral config such as `export default {}`. The command supports `--config`, `--config-loader native|tsx` and `--mode`. Configuration functions still receive `command: 'migration'`.

This CLI embeds the required core implementation from the same Limina release and has no runtime dependency on `limina`. Neutral configs can be migrated with only this tool and its required TypeScript peer. Configs importing public `limina` still require the main package in the project. Enabled optional loaders/checkers require their supported peers. It preserves migration's existing prompts, transaction recovery and fresh-process input verification. Success means the embedded normal check/graph input readers consumed the disk configuration, not that the project’s installed Limina runtime or full checks ran. The CLI reports project version observations separately; mismatched tool build/self versions fail before writes. Persisted schema paths stay in `node_modules/limina/schemas`; editor resolution requires the main package. Successful migration does not replace `limina check`. It does not install project or framework dependencies.

`limina migration` remains a deprecated forwarding command. It uses a locally available matching migration package or downloads that exact version through npm. Install `limina-migrate` locally to use the forwarding command offline.

The package provides a CLI, not a public JavaScript migration API. See the [migration contract](../../docs/en/cli.md#limina-migration) for behavior and limitations.

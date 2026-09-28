# limina-migrate

Migrate existing TypeScript configuration into input that Limina can consume.

```sh
pnpm exec limina-migrate
# Or run the version matching your Limina installation:
pnpm dlx limina-migrate@<version>
```

Initialize a Limina configuration with `pnpm exec limina init` first. The command supports `--config`, `--config-loader native|tsx` and `--mode`. Configuration functions still receive `command: 'migration'`.

This CLI depends on the exact same version of `limina`. It preserves migration's existing prompts, transaction recovery and fresh-process input verification. Successful migration does not replace `limina check`. It does not install project or framework dependencies.

`limina migration` remains a deprecated forwarding command. It uses a locally available matching migration package or downloads that exact version through npm. Install `limina-migrate` locally to use the forwarding command offline.

The package provides a CLI, not a public JavaScript migration API. See the [migration contract](../../docs/en/cli.md#limina-migration) for behavior and limitations.

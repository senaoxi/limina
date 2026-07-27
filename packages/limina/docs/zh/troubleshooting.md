# 故障排查

## 接入 Limina 后导入 JSON 报 `TS6307`

项目原先只使用 `tsc -p` 时，通过 `resolveJsonModule` 导入的 JSON 不必显式出现在源 `tsconfig` 的 `files` 或 `include` 中。例如：

```ts
import pkg from '../package.json' with { type: 'json' };
```

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src"],
}
```

这种配置通常可以通过 `tsc -p`。JSON 会因为源码中的 `import` 进入最终 TypeScript 程序，但不会因此成为源 `tsconfig` 解析出的根文件。

Limina 会根据源 `tsconfig` 的根文件集合生成声明构建配置，并在生成配置中使用显式 `files`。如果导入的 JSON 没有被源 `tsconfig` 显式纳入，它也不会出现在 Limina 生成的 `files` 中。随后执行 `checker:build` 时，`tsc -b` 会报告 `TS6307`：

```text
packages/example/src/cli.ts:4:17 - error TS6307: File '<workspace>/packages/example/package.json' is not listed within the file list of project '<workspace>/.limina/tsconfig/checkers/typescript/projects/tsconfig.dts.json'. Projects must list all files or use an 'include' pattern.

4 import pkg from '../package.json' with { type: 'json' }
                  ~~~~~~~~~~~~~~~~~
```

修复方式是在管辖该源码的源 `tsconfig` 中保留 `resolveJsonModule: true`，并显式纳入会被导入的 JSON：

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src", "package.json"],
}
```

如果当前源码范围会导入多个 JSON，也可以使用 JSON glob：

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src", "**/*.json"],
  "exclude": ["dist", ".limina", "**/fixtures/**"],
}
```

`resolveJsonModule` 只负责让 TypeScript 解析 JSON 模块，不会让 `include: ["src"]` 自动匹配 `.json` 文件。Limina 所需的是：被导入的 JSON 同时属于源 `tsconfig` 的根文件集合，从而能够被投影到生成声明配置的 `files` 中。

## 治理区域排除

### `regions.exclude[...].kind is required`

每条排除规则都必须明确一种 candidate `kind`：`workspace-package` 或 `package-scope`。Limina 不会根据路径推断类型。

### `regions.exclude rule does not match a recognized governance root`

根据诊断检查三点：

1. `kind` 与 candidate 类型一致。
2. `include` 选择相对于 `config.rootDir` 的 candidate 词法目录，必要时包含 `../`，而不是包名或 descriptor 路径。
3. 该目录不是 `node_modules`、`.git`、`.limina` 或明确配置的输出目录等固定 discovery ignore。

例如，要选择根目录位于 `packages/legacy-app` 的激活包，应使用 `kind: 'workspace-package'` 和 `include: ['packages/legacy-app']`。

### `Multiple regions.exclude rules match the same governance root`

让同一 `kind` 的模式互不重叠。规则顺序不会决定哪条 `reason` 生效。

嵌套 `pnpm-workspace.yaml` 不需要 exclusion rule。它会自动停止当前 owner 的遍历；边界下方被激活的包则会独立启动 package-island 任务。

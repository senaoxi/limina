# 故障排查

## 治理区域排除

### `regions.exclude[...].kind is required`

每条排除规则都必须明确一种 candidate `kind`：`workspace-package`、`package-scope` 或 `pnpm-workspace`。Limina 不会根据路径推断类型。

### `regions.exclude rule does not match a recognized governance root`

根据诊断检查三点：

1. `kind` 与 candidate 类型一致。
2. `include` 选择相对于工作区根目录的 candidate 目录，而不是包名或 descriptor 路径。
3. 该目录不是 `node_modules`、`.git`、`.limina` 或明确配置的输出目录等固定 discovery ignore。

例如，嵌套工作区清单位于 `packages/app/fixture/pnpm-workspace.yaml` 时，应使用 `kind: 'pnpm-workspace'` 和 `include: ['packages/app/fixture']`。

### `Multiple regions.exclude rules match the same governance root`

让同一 `kind` 的模式互不重叠。规则顺序不会决定哪条 `reason` 生效。

### `regions.exclude cannot exclude the root pnpm workspace`

根 `pnpm-workspace.yaml` 定义当前治理起点。如果不应治理这个工作区，应从其他工作区根目录运行 Limina。如果只想排除被激活的根包，应使用 `kind: 'workspace-package'` 和 `include: ['.']`。

### `Failed to inspect nested pnpm workspace region`

根据诊断中的 `phase` 定位问题：

- `manifest-validation`：修复 YAML、pnpm 工作区 schema 或 catalog 配置。
- `package-discovery`：修复包清单、工作区包发现或包 identity。

如果嵌套工作区只是有意保留的无效 fixture 数据，应使用 `kind: 'pnpm-workspace'` 显式排除它的根目录。Limina 会在读取嵌套清单前应用该规则，同时保留这个硬边界。

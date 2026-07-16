# 故障排查

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

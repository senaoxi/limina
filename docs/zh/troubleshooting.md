# 故障排查

先定位失败任务，再按问题代码、源码路径和配置路径处理。以下是通用入口；后面的章节处理 JSON 根文件和治理区域等具体问题。

## 先定位失败任务

本次运行的终端输出是首要线索。重新查看已经保存的问题时，使用：

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task source:check
```

`--issues` 不重跑检查。它读取选定治理根的持久化状态；最新已登记尝试未完成、被中断或记录损坏时，不会退回旧问题。配置加载等发生在尝试登记之前的错误，可能保留上一份完成记录，因此还应核对记录时间与本次终端错误。查询范围和参数见[问题查询](./cli.md#limina-check-pipeline)。

| 失败任务                          | 优先查看                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `workspace:validate`              | 治理根、包区域、重复包身份和不安全的输出目录                                  |
| `graph:check`                     | 声明提供者、被消费入口的解析、包依赖声明与图规则                              |
| `source:check`                    | 源码所属包、跨包相对导入、`#imports` 与裸包导入授权；启用 Knip 时再看使用情况 |
| `proof:check`                     | 期望源码是否有检查覆盖，是否重复归属，源码与检查器配置是否一致                |
| `checker:build`                   | 负责构建的检查器、配置路径、退出码和原始日志                                  |
| `checker:typecheck`               | Astro / Svelte 检查器依赖、框架生成类型和源码诊断                             |
| `package:check` / `release:check` | 已配置的输出目录、打包文件、分析器与发布依赖                                  |

修复结构问题后，再处理依赖这些结构的检查器错误。这是排查建议，不代表任务严格按表中顺序运行。`disabled`、`blocked`、`skipped` 分别表示无适用工作、前提受阻或跳过，均不代表相应检查通过。

修改源码范围和规则时，编辑用户维护的配置，再重新运行相关命令；不要手工修补 `.limina/` 中的生成配置。

## 接入 Limina 后导入 JSON 报 `TS6307`

未启用 `composite` 的项目使用 `tsc -p` 时，即使源码配置的 `files` 或 `include` 未选择 JSON，也可能接受通过 `resolveJsonModule` 导入的 JSON。启用 `composite` 的项目直接执行时就可能要求根文件列表完整。例如：

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

使用 `composite: false` 时，这份配置可能通过 `tsc -p`。导入会让 JSON 进入程序，但源 `tsconfig` 没有将它选为根文件。Limina 在生成的声明配置中启用 `composite`，要求该 JSON 同时属于根文件集合。

Limina 会根据源 `tsconfig` 的根文件集合生成声明构建配置，并在生成配置中使用显式 `files`。如果导入的 JSON 没有被源 `tsconfig` 显式纳入，它也不会出现在 Limina 生成的 `files` 中。随后执行 `checker:build` 时，`tsc -b` 会报告 `TS6307`：

```text
packages/example/src/cli.ts:4:17 - error TS6307: File '<workspace>/packages/example/package.json' is not listed within the file list of project '<workspace>/.limina/tsconfig/checkers/tsc/projects/packages/example/tsconfig.dts.json'. Projects must list all files or use an 'include' pattern.

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

如果当前源码范围会导入多个 JSON，也可以使用 JSON 通配模式：

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src", "**/*.json"],
  "exclude": ["dist", ".limina", "**/fixtures/**"],
}
```

`resolveJsonModule` 只负责让 TypeScript 解析 JSON 模块，不会让 `include: ["src"]` 自动匹配 `.json` 文件。将被导入的 JSON 纳入源 `tsconfig` 的根文件集合，它才会出现在生成声明配置的 `files` 中。

## 治理区域排除

### 排除规则缺少 `kind` {#regions-exclude-kind-is-required}

每条排除规则必须声明一种 `kind`：`workspace-package`、`package-scope` 或 `tsconfig`。Limina 不根据路径推断类型。前两者选择候选根目录；`tsconfig` 选择相对于配置根的精确 `tsconfig.json` 或 `tsconfig.*.json` 文件路径，不接受通配模式，并保持包激活。

### 排除规则未匹配精确治理候选 {#regions-exclude-rule-does-not-match-a-recognized-governance-root}

诊断格式为 `regions.exclude[索引] does not match an exact governance candidate.`，其中“索引”是未匹配规则的位置。根据诊断检查三点：

1. `kind` 与候选类型一致。
2. 对于 `workspace-package` 或 `package-scope`，`include` 选择相对于 `config.rootDir` 的候选词法目录，必要时包含 `../`，而不是包名或配置描述文件路径。
3. 该目录不是 `node_modules`、`.git`、`.limina` 或明确配置的输出目录等固定发现排除项。

例如，要选择根目录位于 `packages/legacy-app` 的激活包，应使用 `kind: 'workspace-package'` 和 `include: ['packages/legacy-app']`。

### 多条排除规则匹配同一治理候选 {#multiple-regions-exclude-rules-match-the-same-governance-root}

诊断以 `Multiple regions.exclude rules match` 开头，并列出候选的 `kind` 和路径。让同一 `kind` 的模式互不重叠；规则顺序不会决定哪条 `reason` 生效。

嵌套工作区根（`pnpm-workspace.yaml` 或具有自有 `workspaces` 字段的 `package.json`）不需要排除规则。它会自动停止当前包的遍历；边界下方被激活的包则各自启动独立的包治理任务。

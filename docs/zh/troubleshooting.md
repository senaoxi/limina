# 故障排查

遇到错误时，先看是哪项任务失败，再根据问题代码、文件路径和配置路径缩小范围。下面先介绍通用排查方法，再处理 JSON 导入和治理区域等具体问题。

## 先定位失败任务

本次运行的终端输出是首要线索。重新查看已经保存的问题时，使用：

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task source:check
```

`--issues` 不会重新运行检查，它读取选定治理根保存的检查记录。最新已登记的检查未完成、被中断或记录损坏时，查询不会退回旧问题。配置加载等发生在尝试登记之前的错误，可能保留上一份完成记录，因此还应核对记录时间与本次终端错误。查询范围和参数见[问题查询](./cli.md#limina-check-pipeline)。

查询成功时，显示的记录仍可能包含失败的检查和问题。即使提示没有快照，查询也可能成功退出。持续集成中应运行 `limina check`，并查看任务状态。

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

修改源码范围和规则时，请编辑自己维护的配置，再重新运行相关命令。不要手工修补 `.limina/` 中的生成配置。

## 常见问题

### 新增文件后出现 `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`

这表示文件在期望检查的源码范围中，但没有获得要求的覆盖。先运行 `pnpm exec limina check --issues --task proof:check --verbose` 查看文件和候选配置，再根据文件用途处理：

- 应由现有配置检查：检查该 `tsconfig` 的 `files`、`include` 和 `exclude`，把文件纳入合适的源码配置。
- 需要单独的类型环境：准备独立源码配置，并让已选 `tsconfig.json` 入口能够通过聚合引用找到它。
- 不应属于本次治理：调整 [`scope.source`](./config/source-boundary.md)，同时检查类型检查器是否仍会包含它。
- 留在治理范围但有意不覆盖：仅对具体文件使用有原因的[允许清单](./config/proof-allowlist.md)。

例如，`limina.config.mts` 本身也会匹配默认 TypeScript 源码范围。如果项目只让 `tsconfig` 包含 `src`，它可能成为未覆盖文件。[快速开始](./getting-started.md#看一次检查如何发现遗漏)展示了一个完整例子。

### 相对导入跨过包边界

`LIMINA_SOURCE_RELATIVE_IMPORT_ESCAPES_SCOPE` 表示源码的相对导入跨过了最近的 `package.json` 包边界。查看报告中的导入文件、目标文件和两侧清单。如果确实是在使用另一个包，应让提供方暴露公开入口，在使用方的 `package.json` 声明依赖，并改用包名导入。更完整的说明见[源码检查](./built-in-tasks.md#相对导入不能跨包边界)。

### 包导入没有获得授权

`LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED` 表示导入无法由源码所属包的依赖声明或适用授权解释。查看报告中的包名和清单路径，优先在实际使用该依赖的包中声明它。确实需要共享根目录依赖的场景，再阅读[导入授权](./config/source-checks.md#importauthority)，按需要配置有限的授权。

### 框架检查器缺少依赖或源码未覆盖

先根据报错检查 Vue、Astro 或 Svelte 检查器及其依赖是否位于对应执行范围。Astro 项目还需要提前生成框架类型。

检查器自动发现不会自动把 `.vue`、`.astro`、`.svelte` 加入 Limina 默认源码范围。例如，`tsconfig` 已包含 Vue 组件而 `scope.source` 未包含时，`proof:check` 可能报告 `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`。应按实际需要调整源码范围和框架 `tsconfig`，使两者一致。示例和依赖要求见[快速开始](./getting-started.md#使用-vue-astro-或-svelte)和[框架前置条件](./config/checkers.md#框架前置条件)。

### 检查器构建失败，但摘要没有具体诊断 {#checker-build-diagnostics}

`limina check` 的摘要或保存的问题记录可能只显示失败的检查器和退出码，没有给出编译器的具体诊断。可以运行下面的命令，重新执行适用的内部声明构建并查看输出：

```sh
pnpm exec limina checker build
```

这个命令会重新运行构建型检查器，可能更新 `.limina/` 下的生成文件和缓存，不会构建生产产物。如果工作区或图准备先报错，应先处理该错误，再查看检查器输出。

### pnpm 提示工作区根目录安装限制

如果在 pnpm 工作区根目录安装本地构建包时出现 `ERR_PNPM_ADDING_TO_ROOT`，并且确实要把依赖安装在根目录，请加上 `-w`。例如，源码目录与当前工作区同级时，使用 `pnpm add -D -w file:../limina/packages/limina/dist`。若要安装到某个子包，应在该包或通过包管理器的过滤方式选择正确的包。

## 接入 Limina 后导入 JSON 报 `TS6307`

如果 `checker:build` 的 TypeScript 输出报告导入的 JSON 没有列在项目文件列表中，先检查负责该源码的 `tsconfig` 是否显式包含这个 JSON。

例如，单包 ESM 项目中有以下文件：

`src/index.ts`：

```ts
import settings from './settings.json' with { type: 'json' };

export const name = settings.name;
```

`src/settings.json`：

```json
{ "name": "demo" }
```

`tsconfig.json`：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
    "resolveJsonModule": true,
  },
  "include": ["src/**/*.ts"],
}
```

这里的 `resolveJsonModule` 让 TypeScript 可以解析导入，但 `include` 只选择 `.ts` 文件。普通 `tsc -p` 可能通过。Limina 生成的声明构建配置启用 `composite` 并使用明确的文件列表，在这种布局下，构建可能报告 JSON 的 `TS6307`。实际结果还受文件位置、输出路径和 TypeScript 版本影响，并非每个 JSON 导入都会触发此错误。

要处理这个例子，先将 JSON 加入源码 `tsconfig` 的 `include`，保留其他编译选项：

`tsconfig.json`：

```jsonc
{
  "include": ["src/**/*.ts", "src/settings.json"],
}
```

默认 `scope.source` 不包含 JSON。将文件加入 `tsconfig` 后，如果 `proof:check` 报告 `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`，还需要让 Limina 的源码范围包含这个文件。在项目根目录的 Limina 配置中添加：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', 'src/settings.json'],
    },
  },
});
```

如果已有 Limina 配置，将这个字段合并进去。`...` 保留默认的 TypeScript 文件范围，JSON 路径相对于 Limina 配置确定的项目根目录。调整后重新运行 `pnpm exec limina check`。有多个 JSON 文件时，可按实际范围添加路径或匹配模式。

## 治理区域排除

### 排除规则缺少 `kind` {#regions-exclude-kind-is-required}

每条排除规则必须声明一种 `kind`：`workspace-package`、`package-scope` 或 `tsconfig`。Limina 不根据路径推断类型。前两者选择候选根目录；`tsconfig` 选择相对于配置根的精确 `tsconfig.json` 或 `tsconfig.*.json` 文件路径，不接受通配模式，并保持包激活。

### 排除规则未匹配精确治理候选 {#regions-exclude-rule-does-not-match-a-recognized-governance-root}

诊断格式为 `scope.regions.exclude[索引] does not match an exact governance candidate.`，其中“索引”是未匹配规则的位置。根据诊断检查三点：

1. `kind` 与候选类型一致。
2. 对于 `workspace-package` 或 `package-scope`，`include` 选择相对于 `config.rootDir` 的候选词法目录，必要时包含 `../`，而不是包名或配置描述文件路径。
3. 该目录不是 `node_modules`、`.git`、`.limina` 或明确配置的输出目录等固定发现排除项。

例如，要选择根目录位于 `packages/legacy-app` 的激活包，应使用 `kind: 'workspace-package'` 和 `include: ['packages/legacy-app']`。

### 多条排除规则匹配同一治理候选 {#multiple-regions-exclude-rules-match-the-same-governance-root}

诊断以 `Multiple scope.regions.exclude rules match` 开头，并列出候选的 `kind` 和路径。让同一 `kind` 的模式互不重叠；规则顺序不会决定哪条 `reason` 生效。

嵌套工作区根（`pnpm-workspace.yaml` 或具有自有 `workspaces` 字段的 `package.json`）不需要排除规则。它会自动停止当前包的遍历；边界下方被激活的包则各自启动独立的包治理任务。

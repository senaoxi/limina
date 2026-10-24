# 工具链与检查

[English](../technology-stack.md) | [简体中文](./technology-stack.md)

工具版本由清单和 lockfile 负责。当前工具链使用 pnpm 12.10.1、TypeScript 6.0.3、Rolldown 1.2.10 和 Vitest 4.1.12。Node 范围为 `^22.22.3 || ^24.15.0 || >=26.0`，代码保持 ESM。依赖使用 pnpm catalog、严格 peer、禁用自动 peer 与 hoist、1,440 分钟 release-age 以及既有 trust 策略。保留三份可达 patch 和 manifest-utils 扩展。`verifyDepsBeforeRun: error` 要求显式执行安装以同步依赖。已检入的 release-age 例外仅适用于 `logaria@0.0.4`；其余迁移与发布门禁仍然有效。

仓库命令与必需检查遵循开发工作流的[设置与构建](./development-workflow.md#设置与构建)及[验证与交付](./development-workflow.md#验证与交付)章节。私有工具构建后，Rolldown 生成 JavaScript、声明、发布清单和许可证。

pnpm 12 使用原生可执行文件，发布包中的 Node wrapper 继续作为 Corepack 入口。根目录与文档 workspace 均固定为 12.10.1。pnpm 为包管理器包及各平台二进制生成独立的 lockfile 文档；产品依赖文档继续单独锁定。生成的 lockfile 排除在通用 Prettier 格式化之外，由 pnpm 管理其多文档序列化；frozen 安装和依赖安全门禁继续校验该文件。既有安装、peer、构建许可、release-age 与 trust 设置仍然生效。参见[安装指南](https://pnpm.io/installation)与 [12.10.1 发布记录](https://github.com/pnpm/pnpm/releases/tag/v12.10.1)。

[独立 Vue 矩阵](../../../packages/limina/fixtures/vue-semantic-matrix/package.json)通过 `file:` 依赖安装 Limina 构建产物的 `dist` 清单。该清单变更时，还须刷新[独立矩阵 lockfile](../../../packages/limina/fixtures/vue-semantic-matrix/pnpm-lock.yaml)：先运行 `pnpm run build`，再运行 `pnpm --dir packages/limina/fixtures/vue-semantic-matrix install --lockfile-only --ignore-scripts`。pnpm 12 会在 frozen 安装时拒绝过期的本地依赖 metadata，此时语义检查尚未开始。保留精确 checker tuples 和 CI 的 frozen 安装。

`typecheck`、`check` 和 `lint:packages` 从根目录调用产品 CLI wrapper。根工具、产品、docs 和 build-tools 使用 vue-tsc；ESLint 和 smoke 使用 tsgo。自动发现保持启用。

CI 保留 Linux、macOS 和 Windows 的测试、构建与 smoke 职责，以及独立 Vue semantic matrix。required status 拒绝被跳过的验证任务。所有 Logaria 消费者均通过 dev catalog 使用 registry 0.0.4。setup action 使用 `pnpm install --frozen-lockfile` 安装锁定的依赖，不需要构建 Logaria 源码。Corepack 可用时继续使用；否则通过 npm 安装既有 `packageManager` 固定版本，覆盖不附带 Corepack 的 Node 发行版。2026-09-30 的替换证据和远程／平台限制保留在归档的 Logaria 报告中；[迁移历史](./migration.md#历史证据)说明如何从 Git 获取。历史证据不证明当前 checkout 已通过验收。

## ESLint 10 迁移

仓库自动化、安全报告、CI 复用及带门禁的外部工作流由[基建记录](./infrastructure.md)负责。根工具仅增加已在 catalog 中的 YAML parser，不改变依赖版本或 task runner。

lint catalog 现解析为 ESLint 10.11.0、typescript-eslint 8.71.0、Unicorn 76.0.0、Node plugin 18.4.0、pnpm plugin 1.9.1、HTML plugin/parser 0.66.1、Prettier plugin 5.5.6、flat-gitignore 2.4.0、JSONC parser 3.3.0 和 YAML parser 2.1.0。既有 Prettier config 10.1.8 与 globals 17.12.0 仍为当前版本。Regexp 现解析为 3.3.1，其 parser 要求 Node `^22.22.2 || >=24.15.0`，与当前 Node 范围兼容。旧 baseline 曾阻断这一升级，因此此前保留 `~3.1.1`；该历史限制不再是当前版本约束。已移除过时的 HTML parser 通配符 hook，以及随之不可达的 minimatch 3 patch/overrides。

完整的新版 Unicorn recommended preset 在 JavaScript 和 TypeScript 上启用，随后应用仓库既有规则覆盖；它不处理 YAML/JSON/HTML parser 节点。根配置显式导入根文件设置，不再从组合后的 preset 筛选所有含 `files` 的项，避免在共享覆盖之后意外重放推荐规则。[配置测试](../../../packages/gates/src/eslint/__tests__/general.spec.ts)覆盖 YAML 注释保留、JavaScript 修复和覆盖顺序。尽管 ESLint 10 改为按文件查找配置，根命令仍显式传入配置路径。

`@types/node` 的 catalog 与 override 保持 22.18.0，独立于运行时最低版本；ES2023 emit target 与既有类型库均不变。此次 baseline 变更不引入新的运行时 API。全仓库规则整改保留缓存生命周期、Promise 身份、fixture 边界和字符串代码单元排序；可变模块状态仍由原模块持有。错误包装与 package-import 字面替换由[系统模型](./system-model.md#failure-semantics-与投影边界)说明。

归档的 ESLint 10 报告记录当时的本地基线、三轮独立对抗性测试、检查结果及未覆盖条件；[迁移历史](./migration.md#历史证据)说明如何从 Git 获取。该记录不解除独立 CI、发布或部署门禁。

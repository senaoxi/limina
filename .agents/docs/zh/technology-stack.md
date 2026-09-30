# 工具链与检查

[English](../technology-stack.md) | [简体中文](./technology-stack.md)

工具版本由清单和 lockfile 负责。本次迁移保留 pnpm 11.9.0、TypeScript 6.0.3、Rolldown 1.2.10 和 Vitest 4.1.11。Node 范围为 `^22.18.0 || >=24.11.0`，代码保持 ESM。依赖使用 pnpm catalog、严格 peer、禁用自动 peer 与 hoist、1,440 分钟 release-age 以及既有 trust 策略。保留三份可达 patch 和 manifest-utils 扩展。`verifyDepsBeforeRun: error` 要求显式执行安装以同步依赖。维护者仅批准 `logaria@0.0.4` 的 release-age 例外；其余迁移与发布门禁仍然有效。

先运行 `pnpm install --frozen-lockfile`，再运行 `pnpm run build`。`build:tools` 先编译两个私有工具，随后 Rolldown 生成 JavaScript、声明、发布清单和许可证。`test` 在单元、工具和 integration 测试前构建；`smoke` 在打包消费者测试前构建。`docs:build` 使用本地构建模式和提交信息，以 `/` 为 base 构建双语文档。

`lint:check` 和 `format:check` 只读；修改入口分别为 `lint:fix` 和 `format:write`。`typecheck`、`check` 和 `lint:packages` 从根目录调用产品 CLI wrapper。根工具、产品、docs 和 build-tools 使用 vue-tsc；ESLint 和 smoke 使用 tsgo。自动发现保持启用。

CI 保留 Linux、macOS 和 Windows 的测试、构建与 smoke 职责，以及独立 Vue semantic matrix。required status 拒绝被跳过的验证任务。所有 Logaria 消费者现均通过 dev catalog 使用 registry 0.0.4。setup action 仍在 frozen install 前拒绝临时 Logaria link，不再需要旧仓库构建。本地替换证据和远程／平台限制见 [Logaria 替换验证](../../../migration/LOGARIA-0.0.4.md)。

## ESLint 10 迁移

仓库自动化、安全报告、CI 复用及带门禁的外部工作流由[基建记录](./infrastructure.md)负责。根工具仅增加已在 catalog 中的 YAML parser，不改变依赖版本或 task runner。

lint catalog 现解析为 ESLint 10.11.0、typescript-eslint 8.71.0、Unicorn 76.0.0、Node plugin 18.4.0、pnpm plugin 1.9.1、HTML plugin/parser 0.66.1、Prettier plugin 5.5.6、flat-gitignore 2.4.0、JSONC parser 3.3.0 和 YAML parser 2.1.0。既有 Prettier config 10.1.8 与 globals 17.12.0 仍为当前版本。Regexp 保持兼容的 `~3.1.1` 版本线：3.3.1 引入的 parser 要求 Node `^22.22.2 || >=24.15.0`，高于本仓库声明的最低版本。已移除过时的 HTML parser 通配符 hook，以及随之不可达的 minimatch 3 patch/overrides。

完整的新版 Unicorn recommended preset 在 JavaScript 和 TypeScript 上启用，随后应用仓库既有规则覆盖；它不处理 YAML/JSON/HTML parser 节点。根配置显式导入根文件设置，不再从组合后的 preset 筛选所有含 `files` 的项，避免在共享覆盖之后意外重放推荐规则。[配置测试](../../../packages/eslint-config/src/__tests__/general.spec.ts)覆盖 YAML 注释保留、JavaScript 修复和覆盖顺序。尽管 ESLint 10 改为按文件查找配置，根命令仍显式传入配置路径。

类型库暴露 Node 22.18 已支持的 collection、object、promise 与 iterator API，emit target 仍为 ES2023。该最低版本不支持 `Promise.try`，代码不使用此 API。全仓库规则整改保留缓存生命周期、Promise 身份、fixture 边界和字符串代码单元排序；可变模块状态仍由原模块持有。错误包装与 package-import 字面替换由[系统模型](./limina-system-model.md)说明。

本地基线、三轮独立对抗性测试、完整检查结果与未覆盖条件记录在 [ESLint 10 迁移验证](../../../migration/ESLINT-10.md)。该记录不解除独立 CI、发布或部署门禁。

# 工具链与检查

[English](../technology-stack.md) | [简体中文](./technology-stack.md)

工具版本由清单和 lockfile 负责。本次迁移保留 pnpm 11.9.0、TypeScript 6.0.3、Rolldown 1.2.10 和 Vitest 4.1.11。Node 范围为 `^22.18.0 || >=24.11.0`，代码保持 ESM。依赖使用 pnpm catalog、严格 peer、禁用自动 peer 与 hoist、1,440 分钟 release-age 以及既有 trust 策略。保留四份可达 patch 和 manifest-utils 扩展。`verifyDepsBeforeRun: error` 要求显式执行安装以同步依赖。

先运行 `pnpm install --frozen-lockfile`，再运行 `pnpm run build`。`build:tools` 先编译两个私有工具，随后 Rolldown 生成 JavaScript、声明、发布清单和许可证。`test` 在单元、工具和 integration 测试前构建；`smoke` 在打包消费者测试前构建。`docs:build` 使用本地构建模式和提交信息，以 `/` 为 base 构建双语文档。

`lint:check` 和 `format:check` 只读；修改入口分别为 `lint:fix` 和 `format:write`。`typecheck`、`check` 和 `lint:packages` 从根目录调用产品 CLI wrapper。根工具、产品、docs 和 build-tools 使用 vue-tsc；ESLint 和 smoke 使用 tsgo。自动发现保持启用。

CI 保留 Linux、macOS 和 Windows 的测试、构建与 smoke 职责，以及独立 Vue semantic matrix。required status 拒绝被跳过的验证任务。在批准可独立消费的来源前，临时 Logaria link 明确阻断独立 CI，不授权在 CI 构建旧仓库。

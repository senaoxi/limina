# 依赖许可证策略

[English](../license-policy.md) | [简体中文](./license-policy.md)

本页负责[依赖准入][dependency-admission]与 [bundled-code 许可证门禁][license-loader]共享的支持列表。两个语言版本引用同一个数据区块；仅在英文页维护该列表。

## 支持的许可证

完整列表见英文页的[共享 JSON 数据区块][supported-licenses]，中文版本不复制枚举。

## 维护与适用范围

保留且仅保留一个带 `json` 语言标签的顶层 fenced 代码块。其值必须是非空数组，元素为不重复、不为空且无首尾空白的许可证字符串。loader 在模块导入时从源码或编译后的门禁包位置相对读取文件，不依赖工作目录。文件缺失、JSON 区块缺失或重复、JSON 无效以及列表值无效都会终止加载，不回退到其他列表。修改列表后须启动新的构建进程。

[Marked 的公开 Lexer API][marked-lexer]将 Markdown 解析为 tokens；loader 选择顶层且带 `json` 标签的 `code` token，再将其文本交给 Node 的 JSON parser。Markdown 围栏形式与换行遵循 Marked 的语法。嵌套在引用或列表中的代码块，以及其他代码块内形似围栏的文本，不提供策略数据。本地不实现 Markdown 解析规则，也不渲染 HTML。

bundle 门禁将许可证 metadata 与列表逐字匹配，不解析多许可证表达式。列入支持范围不豁免署名、notices、再分发义务，也不豁免[依赖准入][dependency-admission]对非宽松许可证要求的明确审查。[仓库门禁](./gates.md)要求独立的 [GitHub dependency-review 配置][dependency-review]包含完全相同的集合：pre-commit 读取两个已暂存文件，CI 检查工作区。它拒绝漂移与无效数据，通过检查保障一致性，不依赖注释，也不改写文件。

[发布工具测试][license-tests]通过编译后的模块覆盖列表修改与损坏的策略数据，并保留已有的 bundled-license 缺失、冲突与禁止项检查。

## Parser 依赖

`marked` 18.0.14 是私有 gates 包的 development dependency，固定在 [catalog][catalog] 与 [lockfile][lockfile] 中。2026-10-06 的准入审查发现，[registry metadata][marked-registry]、tagged source 与发布包中的 MIT 许可证一致，registry 未标记废弃，没有运行时依赖或安装脚本，Node `>=20` 要求兼容仓库下限。[该版本][marked-release]发布于 2026-09-22，符合既有 release-age 规则。tarball 通过 SHA-512 integrity 校验；隔离环境的 `npm audit` 返回零漏洞，`npm audit signatures` 验证了 registry signature 与 provenance attestation。解析仅使用发布的 ESM 入口与自带类型声明；该包不进入两个产品产物。

VitePress 已为文档打包 Markdown renderer，但在此复用会将同步的许可证 loader 耦合到文档工具链与异步 renderer 初始化。[Prettier 的公开 API][prettier-api]服务于格式化，而非所需的独立 Markdown token stream。[markdown-it][markdown-it] 15.0.2 是合适的独立 parser，但会增加六个运行时依赖；Marked 在不引入该依赖图的情况下提供所需 tokens。既有准入、trust、release-age 与 audit 规则继续生效。

[dependency-admission]: ./dependency-admission.md#许可证兼容性
[supported-licenses]: ../license-policy.md#supported-licenses
[license-loader]: ../../../packages/gates/src/license-policy.ts
[markdown-it]: https://github.com/markdown-it/markdown-it
[dependency-review]: ../../../.github/dependency-review-config.yml
[license-tests]: ../../../scripts/release/publication.spec.ts
[marked-lexer]: https://marked.js.org/using_pro#lexer
[catalog]: ../../../pnpm-workspace.yaml
[lockfile]: ../../../pnpm-lock.yaml
[marked-registry]: https://registry.npmjs.org/marked/18.0.14
[marked-release]: https://github.com/markedjs/marked/releases/tag/v18.0.14
[prettier-api]: https://prettier.io/docs/api

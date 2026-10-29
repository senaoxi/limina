# 配置项设计心智模型

[English](../configuration-design.md) | [简体中文](./configuration-design.md)

**核心能力扁平化、复杂选项领域化、共享职责聚合化、默认行为约定化。** 配置应帮助使用者表达意图，而不是要求其先学习 Limina 的内部架构。每一层新增嵌套都应提供明确的语义价值，而不只是让结构看起来整齐。

本文维护配置设计的理由与审查标准。[公共类型](../../../packages/limina/src/config/root-types.ts)和[运行时 Schema](../../../packages/limina/src/config/schema/root.ts)定义可接受的配置；[配置参考](../../../docs/zh/config/index.md)负责用法与字段细节。这些原则属于设计指导，不代表某一种配置结构是社区通用且唯一的最佳实践。

## 四条原则

### 核心能力扁平化

`graph`、`source`、`proof`、`package`、`release` 等可独立理解的治理领域直接暴露在顶层。使用者要配置源码检查时，可以直接进入 `source`，不必先学习额外的 `checks` 分类。不要仅因为多个能力都执行检查，就再加一层包装。

预期收益是降低发现成本：使用者应能从已经理解的概念中找到下一项配置。扁平配置与嵌套配置都可以提供 TypeScript 补全；扁平化并不创造这项能力。[defineConfig](../../../packages/limina/src/config/define.ts)提供类型引导并保留输入值。嵌套应帮助使用者收窄有意义的选择，而不是要求其猜测功能藏在哪一层。

### 复杂选项领域化

相关细节放在所属领域内部，例如 `graph.rules`、`source.knip`、`cache.dependencies`。不要只为缩短路径而把所有叶子选项提到顶层，否则会丢失归属信息并增加命名歧义。

作用范围与功能名称同样重要。[包配置](../../../packages/limina/src/config/package-types.ts)把 `attw` 绑定到具体产物条目；将其提升为全局开关，需要新增应用范围与覆盖语义，不只是缩短写法。只有能力本身存在明确启停契约时，才使用简单开关与详细对象并存的形式；不要强制所有配置域都支持 `boolean | object`。

### 共享职责聚合化

`scope` 聚合建立治理边界及 checker 归属的输入：`scope.regions` 选择结构区域，`scope.source` 选择被治理源码，`scope.checkers` 选择 checker 入口及归属。分组说明共同职责，不意味着这些选择器的语义可以互换。

尤其要区分：`scope.source` 回答哪些源码需要获得治理覆盖，顶层 `source` 配置源码检查策略。源码选择器不能激活未受治理的区域，checker 入口排除也不会截断已经选定的引用闭包。类型、字段注释、[源码边界](../../../docs/zh/config/source-boundary.md)与[检查器](../../../docs/zh/config/checkers.md)参考都应明确这些区别。

### 默认行为约定化

能够由已验证的项目事实和既有默认值确定的行为，不要求使用者重复声明。不要为让配置显得完整，要求重复填写工作区声明、自动 checker 发现或默认源码模式。默认行为必须受支持的语义约束，不能借此猜测缺失的治理权限。

只有需要定制时才暴露复杂度。省略选项应保留对应默认值，但显式空对象或空数组并不自动等价于省略。例如，[源码选择](../../../docs/zh/config/source-boundary.md)为 `...` 定义了明确的默认展开语义，[缓存 Schema](../../../packages/limina/src/config/schema/root.ts)则要求对象形式的缓存配置包含 `dependencies`。示例必须遵守这些契约，而不是为每个配置域填上 `{}`。

## 在 Limina 中的应用边界

区分治理范围、检查策略、工作流定义、并发控制与分析缓存复用。`pipelines` 回答执行哪些步骤以及顺序；并发选项控制并行工作数量；`cache` 控制持久化分析复用，并非所有 checker 自身的缓存。具体机制仍由[流水线参考](../../../docs/zh/config/pipelines.md)、[并发参考](../../../docs/zh/config/execution.md)和[生命周期记录](./lifecycle.md)维护。

当前[公共类型](../../../packages/limina/src/config/root-types.ts)和[消费方](../../../packages/limina/src/execution/config.ts)采用 `concurrency` 命名。这是源码层面的事实，不意味着为了满足本模型，必须重命名一个原本已经可以理解的字段。重命名或重新分组应有足以抵消迁移成本的具体易用性或语义收益。本记录不证明迁移已经通过运行时验收，也不证明其已随版本发布。

公共分组不必映射内部 provider、分析阶段或缓存 epoch。反过来，移动公共字段也不能改变它的治理权限与消费关系：例如，[包产物声明](../../../packages/limina/src/core/workspace/validated/outputs/collection.ts)虽然位于 `package` 下，仍会影响工作区输出边界。除非明确进行独立的行为变更，否则保持路径基准、默认行为、checker 归属、pipeline 顺序与缓存有效性语义不变。

## 新增选项或调整分组时的审查

扩展配置前，回答三个问题：

1. **使用者要决定什么，作用范围是什么？** 区分共享治理输入、单一检查领域或具体条目，选择最近且有明确含义的归属。
2. **这个选项是否有必要存在？** 既有默认值或可靠项目事实已经能够表达意图时，优先复用；不要为假设的未来需求新增输入、覆盖机制或通用包装层。
3. **新路径具体改善了什么？** 将发现成本或语义清晰度的收益，与额外嵌套、顶层噪声及兼容成本比较。减少顶层字段数量本身并不构成收益。

合法值和拒绝条件保留在可执行契约中，设计理由由本文维护。语义影响遵循[架构工作流](./architecture-workflow.md)，验证遵循[开发工作流](./development-workflow.md)。优先进行最小必要调整，不为形式统一重新组织已经清晰的公共 API。

## 固定默认检查与配置

independent 默认计划始终包含 `graph:check`、`source:check`、`proof:check`、`checker:build` 和 `checker:typecheck`。`scope` 提供输入和 Checker 权威；顶层治理域配置规则、例外及可选子能力，不决定任务是否存在。空配置使用默认策略，不缩减覆盖。显式流水线自行选择步骤，独立检查保留各自领域合同；package/release 不加入默认任务。

配置域仍须遵守显式结构：配置 Graph、Proof 时分别要求 `graph.rules`、`proof.allowlist`，Source 要求至少一个支持的字段。这些输入约束不决定默认任务集合。空集合表示没有附加规则或例外，`source: { knip: false }` 仅关闭 Knip。未知字段和显式 undefined 仍无效。原始属性验证先于 Zod 形状验证，保留非枚举顶层域，同时拒绝 accessor、Proxy、继承及隐藏的嵌套字段。动态值在配置函数内计算，验证不补默认值、不替换返回数据。

现有 Zod 与 Node 属性描述符足以实现，不增加依赖或工作流抽象。Graph/Knip 的结构错误前移到配置加载；依赖工作区事实的语义诊断仍属于领域检查。`fixtures/config-errors` 保留原非法输入，替代的语义 detector fixture 继续保护领域诊断边界。

证据：[configuration tests](../../../packages/limina/src/__tests__/config.spec.ts), [default workflow CLI tests](../../../packages/limina/integration/tests/default-check-workflow.spec.ts), [cache process tests](../../../packages/limina/integration/tests/config-process-cache.spec.ts).

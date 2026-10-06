# 配置参考

配置通常放在项目 `package.json` 旁的 `limina.config.mts`。首次接入可先保留默认区域、默认源码范围和检查器自动发现，再按实际问题补充规则。

## 按配置目的阅读

| 你要决定什么                                       | 配置入口                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| 使用哪份配置、以哪个包为治理根、按环境返回什么配置 | [配置文件](./config-file.md)：`defineConfig`、加载器、`mode`、`command` |
| 哪些包与嵌套包作用域纳入本次运行                   | [治理区域](./regions.md)：`regions`                                     |
| 哪些源码必须获得检查覆盖                           | [源码边界](./source-boundary.md)：`config.source`                       |
| 每份源码配置由哪个检查器负责                       | [检查器配置](./checkers.md)：`config.checkers`                          |
| 源码导入由谁授权，如何检查未使用代码               | [源码检查](./source-checks.md)：顶层 `source`                           |
| 哪些项目引用、包或内置模块依赖不允许出现           | [图规则](./graph-rules.md)：`graph.rules` 与源码配置中的标签            |
| 声明引用树是否使用一致的解析条件                   | [条件域](./condition-domains.md)：`graph.conditionDomains`              |
| 哪些具体文件暂时不要求普通检查覆盖                 | [覆盖证明允许清单](./proof-allowlist.md)：`proof.allowlist`             |
| 哪些已构建输出需要检查                             | [包检查](./package-checks.md)：`package.entries`                        |
| 如何检查打包文件与工作区发布依赖                   | [发布检查](./release-checks.md)：`release`                              |
| 如何组合任务、控制执行资源                         | [流水线](./pipelines.md)与[执行并发](./execution.md)                    |

## 建议的配置顺序

先确定配置文件和治理根，再核对包区域、源码范围及检查器自动发现的结果。需要固定检查器或依赖方向时，再添加具名范围与图规则。需要发布包时，最后配置输出条目和相关检查。

`config.source` 决定哪些文件需要覆盖，顶层 `source` 配置源码检查策略；两者用途不同。`regions.exclude`、源码排除和检查器入口排除的区别见[治理区域](./regions.md)。

源码 `tsconfig` 中的 `liminaOptions` 用于声明图规则标签、静态分析不可见的声明关系和用户产物输出，概念及示例见[核心概念](../concepts.md)。

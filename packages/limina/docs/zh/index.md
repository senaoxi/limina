---
layout: home

hero:
  name: Limina
  text: TypeScript 单体仓库架构治理
  tagline: 让工作区导出、项目引用、包边界、Nx 构建边和发布产物始终各说同一件事——在代码审查和 CI 阶段发现问题，而不是发布之后。
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/getting-started
    - theme: alt
      text: 为什么需要 Limina
      link: /zh/why
    - theme: alt
      text: 在 GitHub 查看
      link: https://github.com/senaoxi/docs-islands/tree/main/packages/limina

features:
  - icon: 🔗
    title: 看清真实依赖图
    details: PR 新增跨包导入时，立即知道该补项目引用、工作区依赖、产物构建边，还是改架构规则——赶在图发生漂移之前。
    link: /zh/built-in-tasks
    linkText: 内置任务
  - icon: 🚧
    title: 让包边界清楚
    details: '每一条跨包依赖都必须经由声明过的依赖和该包的公开导出解析。Limina 会标记跨包相对导入、漏写的依赖声明、逃出当前包的 #imports、混入多个归属方的 tsconfig、未被使用的工作区依赖和无人引用的源码模块，并在 strict 模式下标记绕过 workspace: 协议的跨包依赖。'
    link: /zh/built-in-tasks
    linkText: 源码检查
  - icon: ✅
    title: 证明每个文件都被检查
    details: 把声明叶子与严格的本地配套配置、vue-tsc / svelte-check 等框架检查器对起来，证明没有源码文件漏过所有检查器。
    link: /zh/config/checkers
    linkText: 检查器入口
  - icon: 📦
    title: 发布真正可用的产物
    details: 用 publint、Are the Types Wrong 和运行时导入边界扫描，检查消费者真正安装的 dist：包元数据、导出和类型解析。
    link: /zh/config/package-checks
    linkText: 包检查
  - icon: 🚀
    title: 安心发布
    details: 打出 npm tarball 并检查发布卫生：README/license 是否齐全、是否误带源码映射，并与 npm registry 基线逐文件比对内容。
    link: /zh/config/release-checks
    linkText: 发布检查
  - icon: 🧩
    title: 把检查编排成流水线
    details: 把 Limina 任务和 shell 命令组合成本地、PR、发布等命名工作流。Limina 是对 Nx、Turborepo 这类任务运行器的补充，而非替代。
    link: /zh/workflows
    linkText: 工作流
---

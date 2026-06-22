---
layout: home

hero:
  name: Limina
  text: TypeScript 单体仓库架构治理工具
  tagline: 先接入增量构建，再逐步打开架构治理
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: 开始接入
      link: /zh/getting-started
    - theme: alt
      text: 查看内置任务
      link: /zh/built-in-tasks
    - theme: alt
      text: 在 GitHub 查看
      link: https://github.com/senaoxi/docs-islands/tree/main/packages/limina

features:
  - icon: ⚙️
    title: 接入增量构建
    details: >
      读取现有 TypeScript 配置和源码依赖关系，生成可复用的类型构建配置，并安排合理的构建顺序。
      支持 TypeScript、Vue 等检查方式，团队无需大改工程结构，也能渐进接入到大型仓库。
    link: /zh/getting-started
    linkText: 开始接入

  - icon: 🕸️
    title: 治理依赖关系
    details: >
      持续检查项目之间的引用关系、访问边界和依赖声明，发现缺失、冗余或不合理的连接。
      随着仓库规模增长，帮助团队把代码关系保持在清晰、可维护的状态。
    link: /zh/config/graph-rules
    linkText: 配置图规则

  - icon: 🧱
    title: 保护源码边界
    details: >
      发现跨包相对导入、未授权导入、漏写依赖和源码归属问题，避免模块绕过预期入口互相调用。
      让每个包的内部实现和对外能力保持分离，减少后续重构和发布时的边界风险。
    link: /zh/config/source-boundary
    linkText: 配置源码边界

  - icon: 🎯
    title: 确认检查覆盖
    details: >
      找出没有被检查覆盖、被重复覆盖，或检查范围与源码范围不一致的文件。
      团队可以更明确地知道哪些代码已经进入质量检查，哪些位置仍然存在盲区。
    link: /zh/config/checkers
    linkText: 配置检查入口

  - icon: 🚦
    title: 编排检查流程
    details: >
      构建、依赖关系、源码边界和检查覆盖都可以作为独立检测项使用。
      团队可以按本地开发、CI 或发布前场景自由组合流程，并在可并发时并发执行。
    link: /zh/config/pipelines
    linkText: 配置检查流水线

  - icon: 📦
    title: 补充发布检查
    details: >
      发布前验证包信息、类型入口、发布产物和发布包内容，提前发现可能影响使用方的问题。
      这些检查作为主流程之外的补充防线，适合放在正式发布或预发布环节。
    link: /zh/config/release-checks
    linkText: 配置发布检查
---

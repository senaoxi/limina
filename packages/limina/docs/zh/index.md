---
layout: home

hero:
  name: Limina
  text: TypeScript 项目引用图编译器与架构治理 CLI
  tagline: 先接入可增量的 build，再逐步打开完整架构治理。
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
  - icon: 🧭
    title: 低摩擦接入增量 build
    details: limina init 会添加 limina:build，根据现有 tsconfig 和真实导入准备 TypeScript 构建图，让仓库先获得 tsc -b、tsgo 或 vue-tsc 的增量构建收益。
    link: /zh/getting-started
    linkText: 开始 build-first 接入
  - icon: 🕸️
    title: 自动生成类型图
    details: 把 TypeScript、Vue、Svelte 等检查器纳入同一张类型关系图，让构建、检查和诊断使用同一组事实。
    link: /zh/config/checkers
    linkText: 配置检查器
  - icon: 🧱
    title: 治理项目引用关系
    details: 根据真实导入检查缺失引用、非法依赖、跨运行时调用和架构规则违约，让项目关系留在声明过的边界内。
    link: /zh/built-in-tasks
    linkText: 查看图检查
  - icon: 🛡️
    title: 保护包边界
    details: 阻止跨包相对导入、漏写依赖、私有入口逃逸和绕过声明包边界的内部依赖，确保每个包只能通过公开入口被访问。
    link: /zh/built-in-tasks
    linkText: 查看源码检查
  - icon: 🎯
    title: 确认检查覆盖
    details: 对齐源码文件与 TypeScript、Vue、Svelte、test、tools、docs 等检查范围，找出没人检查、重复检查或归属不清的文件。
    link: /zh/config/checkers
    linkText: 配置覆盖范围
  - icon: 📦
    title: 验证发布产物
    details: 检查消费者真正安装到的 npm tarball，确认 package metadata、exports、types、运行时入口和类型解析保持一致。
    link: /zh/config/package-checks
    linkText: 配置包检查
  - icon: 🚦
    title: 发布前发现风险
    details: 在发布前检查 README、license、误带文件、缺失文件、source map 和 registry 基线差异，确认发布内容符合预期。
    link: /zh/config/release-checks
    linkText: 配置发布检查
  - icon: 🧩
    title: 融入现有工作流
    details: 接入本地开发、PR、CI 和发布流程，并在需要时导出用于架构审查的限定依赖图。
    link: /zh/workflows
    linkText: 配置工作流
---

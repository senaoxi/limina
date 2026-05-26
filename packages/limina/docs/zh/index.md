---
layout: home

hero:
  name: Limina
  text: TypeScript monorepo 架构治理
  tagline: 在 CI 和发布前，确认 project references、package 边界、checker 覆盖和发布产物没有各说各话。
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/getting-started
    - theme: alt
      text: 查看 npm
      link: https://www.npmjs.com/package/limina

features:
  - title: 看清真实依赖图
    details: PR 新增跨 package import 时，立即知道该补 project reference、workspace 依赖，还是修架构规则。
  - title: 让 package 边界清楚
    details: 发现跨 package 相对导入、漏写的依赖声明，以及逃出当前 package 的 #imports，让依赖关系回到 manifest 和 exports。
  - title: 知道每个文件被检查
    details: 把 declaration leaf、local typecheck companion 和框架 checker 对起来，第一次失败也能判断是 graph、source、proof 还是 typecheck 问题。
  - title: 发布真正可用的产物
    details: 在 publish 前验证消费者会安装到的 dist，包括 exports、types、README/license 和 runtime import 边界。
---

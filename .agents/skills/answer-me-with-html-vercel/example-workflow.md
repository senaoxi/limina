---
lang: zh
template: sheet
title: 多页面共用一个 Vercel Project
subtitle: answer-me-with-html 的持续发布流程
cols: 2
---
一个 Vercel Project 对应一个完整的静态站点。每个 HTML 通过独立路径访问，发布新页面时要保留已发布的旧文件。

## A 发布流程 {span=2}
```flow LR
生成 HTML -> 本地审核: 隐私与敏感内容
本地审核 -> 持久化归档: 添加 pages/slug.html
持久化归档 -> 生成目录: 更新 index.html
生成目录 -> Vercel 部署: 重新部署完整目录
Vercel 部署 -> HTTPS: 返回单页地址
```

## B 目录与路由
```tree
vercel-shared-site
  index.html | 页面目录
  pages
    require-bindings.html | require 解析解释
    deployment-workflow.html | 当前工作流
```

## C 需要避免的行为
| 操作 | 影响 |
|---|---|
| 仅上传新 HTML | no 旧页面可能从新的部署快照消失 |
| 重复使用同一个 Project | ok 页面共享域名 |
| 把私有源码直接上传 | no 公共部署可能泄露内容 |
| 保存完整页面归档 | ok 旧链接可持续访问 |

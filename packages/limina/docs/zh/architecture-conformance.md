# 架构一致性：让约定、源码和产物互相对得上

架构一致性不是“代码风格统一”，也不是“构建命令能跑完”。它关心的是另一件事：仓库里声明的关系，是否真的被源码导入、包配置、类型检查和发布产物共同证明。

> Limina 检查的不是某一条命令是否成功，而是仓库里的每一层是否在表达同一个架构事实。

比如 `app` 依赖 `core`，这句话至少会出现在几个地方：源码里有 import，`package.json` 里有依赖，`core` 的 `exports` 暴露了入口，类型图能理解这条关系，发布后的包也仍然能被消费者正确安装和使用。只要其中一层说法对不上，仓库就已经开始漂移。

```text
你希望的架构
  │
  ▼
源码实际怎么 import
  │
  ▼
package.json 怎么声明依赖和导出
  │
  ▼
tsconfig 和检查器怎么覆盖文件
  │
  ▼
构建产物和发布包是否仍然可用
```

Limina 的价值就在这里：它把这些原本分散的事实连起来，让你知道问题到底是代码越界、配置漏写、类型图不完整，还是发布出来的包已经和源码不一致。

## 依赖关系要一致

依赖声明很容易让人误会成“我一定在读另一个包的源码”。实际上，它只说明当前包被允许访问另一个包。真正决定导入落到哪里的，是被依赖包的 `exports` 解析结果。

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

当 `app` 导入默认入口：

```ts
import { createClient } from '@acme/core';
```

这个入口解析到 `core` 的源码。它表达的是“两个包在源码层协作”，所以 Limina 会要求类型图也能表达这条源码关系。

当 `app` 导入运行时入口：

```ts
import { renderRuntime } from '@acme/core/runtime';
```

这个入口解析到 `core` 的构建产物。它表达的是“`app` 消费 `core` 已经构建好的结果”，所以 Limina 不会把它当成源码项目引用，而是把对应的产物边导出为限定范围内的架构事实。

同一条包依赖声明，可能代表两种不同架构关系：

| 真实入口 | 架构含义            | Limina 会确认什么          |
| -------- | ------------------- | -------------------------- |
| `src`    | 消费另一个包的源码  | 类型图能表达这条源码关系   |
| `dist`   | 消费另一个包的产物  | 依赖图导出能表达这条产物边 |
| 解析失败 | 公开 API 本身不可靠 | `exports` 或产物需要修正   |

这就是架构一致性的第一层：依赖不能只在代码里发生，它也要被包声明、导出入口和后续检查承认。

## 源码归属要一致

架构越清楚，每个文件越应该知道自己属于哪里。生产源码、测试源码、工具脚本、Vue 文件、Svelte 文件，可能需要不同的检查器和不同的类型环境。

仓库变大后，一个 `tsconfig.json` 很容易同时给 IDE 用、给测试用、给生产源码用、给构建输出用，还顺手写 project references。短期省事，长期会让边界变模糊。

更清楚的结构是：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.tools.json
```

如果目录里只有一种类型环境，`tsconfig.json` 可以直接负责源码。如果目录里有多种环境，`tsconfig.json` 更适合只做聚合入口：

```jsonc [packages/app/tsconfig.json]
{
  "files": [],
  "references": [
    { "path": "./tsconfig.lib.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.tools.json" },
  ],
}
```

Limina 关心的不是你文件名怎么取，而是每份源码有没有明确负责人：哪些进入生产类型图，哪些只属于测试环境，哪些只是工具脚本。如果测试依赖悄悄进入生产图，或者工具脚本被当成库入口发布出去，架构就已经不一致了。

重复归属也会制造问题。例如两个配置都包含同一批源码：

```jsonc [packages/core/tsconfig.lib.json]
{
  "include": ["src/**/*.ts"],
}
```

```jsonc [packages/core/tsconfig.tools.json]
{
  "include": ["src/**/*.ts"],
}
```

这会让同一个文件同时落进两个边界。更好的做法是让它们负责不同文件：

```jsonc [packages/core/tsconfig.lib.json]
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/tools/**"],
}
```

```jsonc [packages/core/tsconfig.tools.json]
{
  "include": ["src/tools/**/*.ts"],
}
```

架构一致性的第二层就是源码归属：文件应该被检查，而且应该被正确的边界检查。

## 包边界要一致

单体仓库里最常见的架构漂移，是代码绕过包边界直接访问另一个包的内部文件：

```ts
import { Button } from '../../ui/src/Button';
```

这段代码可能能跑，但它没有尊重包架构。`app` 的 `package.json` 没有明确声明依赖，`ui` 的 `exports` 没有决定这个文件是不是公开 API，`ui` 内部目录一改，`app` 就可能坏掉。

更一致的写法，是先在清单里声明关系：

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/ui": "workspace:*"
  }
}
```

再通过包名访问公开入口：

```ts
import { Button } from '@acme/ui';
```

Limina 会把这种关系看成一组必须对齐的事实：源码 import 了谁，source owner 或显式允许的 workspace root manifest 候选是否承认它，被依赖包是否真的公开了这个入口。`#imports` 也一样，它会匹配导入文件最近 package scope 的 `imports` 字段；相对 target 必须留在声明它的 package scope 内，package target 可以指向三方包或 workspace dependency，但仍然要被导入文件所属的 source owner 授权。

## 运行时边界要一致

有些边界不是包名能表达清楚的，比如“浏览器代码不能依赖 Node 能力”“公共 API 不能依赖内部实现”“插件运行时不能依赖 CLI 代码”。这些都属于运行时架构。

如果浏览器入口里写了：

```ts
import fs from 'node:fs';
```

普通类型检查不一定会告诉你这是架构错误。Limina 可以用图规则把这条边界写成仓库能执行的约定：

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```js [limina.config.mjs]
export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'client runtime must stay free of Node builtin imports',
            },
          ],
        },
      },
    },
  },
});
```

这样，架构规则就不再只靠“大家记得别这么写”。真实导入命中规则时，Limina 会指出哪个文件越界、导入了什么、为什么不允许。

## 发布产物要一致

源码层一致，不代表发布包也一致。用户安装到的不是你的源码目录，而是构建后的 npm 包。

Limina 的包检查会在构建后看 `outDir`，必要时把它打成 tarball，再从消费者视角确认这些事实：`exports` 指向的文件存在，类型入口能解析，浏览器产物没有导入 Node 内置模块，输出 JS 没有导入未声明的外部包，包内自引用没有访问未导出的入口。

发布检查还会继续看 tarball 是否缺 README/license，是否带出 source map，是否泄漏 `workspace:`、`link:`、`file:` 或 `catalog:` 这类本地协议，以及工作区依赖相对已发布基线是否安全。

这一步检查的是架构一致性的最后一层：源码里说得通的关系，发布给消费者以后仍然要说得通。

## 读诊断时，先找哪层不一致

Limina 的诊断通常不是在说“这个命令失败了”，而是在说“某一层架构事实和另一层对不上”。先判断是哪层不一致，再修代码或配置，效率会高很多。

| 诊断指向的问题           | 通常是哪层没有对齐                                                             |
| ------------------------ | ------------------------------------------------------------------------------ |
| 公开导出解析失败         | `exports`、condition 分支或构建产物没有对上                                    |
| 文件没人检查或被重复检查 | 源码归属和检查器覆盖没有对上                                                   |
| 跨包相对导入             | 源码 import 绕过了包声明和公开 API                                             |
| 裸包导入未授权           | 代码使用了依赖，但 source owner、允许的 root manifest 候选或显式规则没有承认它 |
| 浏览器代码导入 Node 能力 | 真实导入违反了运行时架构规则                                                   |
| 发布包检查失败           | 源码仓库里的关系没有延续到消费者真正安装的包                                   |

所以，“架构一致性”不是一个抽象口号。它是一条很具体的判断标准：你希望仓库长成什么样，源码是否真的这么写，配置是否承认这件事，类型图是否能证明它，发布产物是否还能兑现它。Limina 要做的，就是把这些层重新拉到同一张桌子上。

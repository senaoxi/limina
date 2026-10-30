# 快速开始

本页先用一个小型 TypeScript 项目体验 Limina：运行检查，故意制造一个遗漏，再根据报告修复它。随后介绍如何接入现有项目。Limina 会检查源码范围、依赖关系并调用检查器。项目的生产构建仍由你原来的工具负责。

## 准备环境

本文档介绍当前仓库中的开发版。npm 上的发行包可能尚未包含这里的配置，即使版本号相同也不能据此判断源码是否一致。下面先从与文档对应的源码构建并安装。如果使用发行包，请阅读该发行版本对应的文档。

本版源码要求 Node.js `^22.22.3 || ^24.15.0 || >=26.0`，以及 TypeScript `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`。不同 Limina 发行版本以其声明的对等依赖范围为准。

下面使用 pnpm 和 ESM。Limina 也支持 npm、Yarn、Bun 工作区及单包项目。在已有项目中，请使用项目本来的包管理器。

### 构建开发版

在不属于其他工作区的目录下克隆 Limina：

```sh
git clone https://github.com/senaoxi/limina.git
cd limina
```

如果文档页面底部显示提交号，先将源码切换到该提交：执行 `git checkout <提交号>`，把 `<提交号>` 替换成实际值。如果正在阅读本地开发预览，可以直接使用生成该预览的源码目录。

在 Limina 源码目录中，使用仓库 `package.json` 的 `packageManager` 字段指定的 pnpm 版本，安装依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` 会在仓库内生成 Limina 和迁移工具的构建目录，不会发布它们。

接着在 `limina` 目录的同级创建示例项目：

```sh
cd ..
mkdir limina-example
cd limina-example
```

## 用一个小项目试一试

在刚创建的 `limina-example` 目录中创建以下文件：

`package.json`：

```json
{
  "name": "limina-example",
  "private": true,
  "type": "module"
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

`src/index.ts`：

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

这里的 `types: []` 只让示例不依赖其他环境类型。现有项目应保留自己需要的类型环境。安装刚构建的 Limina 和兼容的 TypeScript：

```sh
pnpm add -D file:../limina/packages/limina/dist typescript@~6.0.3
```

`file:` 让 pnpm 安装构建后的包。这里的相对路径假设 `limina` 源码目录与 `limina-example` 同级。如果目录不同，请调整路径。

在同一目录创建配置：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

空配置已经启用默认检查：Limina 会发现当前项目的 `tsconfig.json`，并使用 TypeScript 检查器处理它。将 `.limina/` 加入项目的 `.gitignore`，然后在项目目录运行：

```sh
pnpm exec limina check
```

检查会在 `.limina/` 中生成内部配置、声明文件、构建缓存和检查记录。示例正常时，输出中会显示 `limina check passed` 和任务摘要。由于示例没有 Astro 或 Svelte 目标，框架类型检查会显示 `disabled`，表示没有适用目标，并不表示框架检查已经运行。

### 看一次检查如何发现遗漏

在项目中新增 `scripts/tool.ts`：

```ts
export const tool = true;
```

再次运行 `pnpm exec limina check`。默认情况下，Limina 会把这个 TypeScript 文件纳入期望检查的源码范围，但示例的 `tsconfig.json` 只包含 `src`，所以 `proof:check` 会报告 `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`。

要查看具体文件，可以读取上一次完成的检查记录：

```sh
pnpm exec limina check --issues --task proof:check --verbose
```

如果这个脚本确实属于项目源码，可把它加入 `tsconfig.json` 的 `include`，然后重新运行检查：

```json
{
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

这个片段只展示需要修改的字段，保留示例原有的 `compilerOptions`。如果脚本需要不同的类型环境，也可以为它准备单独的源码配置，并通过入口配置纳入检查。若文件本来就不应属于本次治理，则需要调整[源码范围](./config/source-boundary.md)，不必为了消除错误而盲目添加允许清单。

## 接入现有项目

先按上面的步骤构建与本文档对应的开发版，再在你希望检查的项目根目录安装构建后的 Limina。已有兼容版本的 TypeScript 可以保留。下面假设项目与 `limina` 源码目录同级：

::: code-group

```bash [pnpm 单包]
pnpm add -D file:../limina/packages/limina/dist
```

```bash [pnpm 工作区根目录]
pnpm add -D -w file:../limina/packages/limina/dist
```

:::

如果目录不同，请调整 `file:` 后的路径。其他包管理器请使用各自的本地包安装方式。

### 选择工作区范围 {#在-monorepo-内选择配置}

在工作区根安装时，请使用包管理器对应的根依赖安装方式。Limina 会以所选配置最近的 `package.json` 所在目录为根，读取该根自身的工作区声明。在子包放置配置会选择子包范围，祖先工作区不会自动扩大它。更多查找规则见[配置文件](./config/config-file.md#治理根)。

### 创建配置 {#最小手动配置}

如果项目已有 Limina 配置，请先使用现有配置。默认查找时，`limina.config.mts` 的优先级高于 `limina.config.mjs`。尚无配置时，可以在选定根目录手动创建上面的 `limina.config.mjs`，也可以使用初始化命令。

::: warning 初始化会修改项目文件
`limina init` 可能创建或修改 `limina.config.mts`、`.gitignore`、`package.json` 和依赖，还会删除根目录的 `.limina/`，包括已有检查和迁移记录。新建的 `.mts` 配置也会优先于同目录已有的 `.mjs` 配置被发现。请先查看并保存需要保留的内容。`--yes` 会接受核心初始化确认，包括覆盖已有配置或冲突脚本。
:::

在选定的项目目录执行：

```sh
pnpm exec limina init
```

初始化会向上查找最近的 `package.json`，并在其旁边创建配置，不会添加工作区声明或改写源码 `tsconfig`。如果它修改了依赖或创建了包清单，按提示重新安装依赖。生成的 `limina:build` 脚本执行 Limina 的内部声明构建，不是生产打包命令。其他初始化行为见[命令行参考](./cli.md#limina-init)。

默认源码范围包含 `.ts`、`.tsx`、`.mts`、`.cts` 及对应声明文件。因此，如果使用 `limina.config.mts`，它也需要被合适的 `tsconfig` 覆盖，或者根据项目实际情况从 `scope.source` 排除，否则可能出现与上例相同的未覆盖报告。手动配置使用 `.mjs` 时不会因扩展名落入这组默认 TypeScript 匹配模式。

例如，若 `limina init` 刚生成的 `.mts` 文件不应由项目检查，也没有被 `tsconfig` 包含，可以在 `scope.source` 中添加排除项：

`limina.config.mts`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: { exclude: ['...', 'limina.config.mts'] },
  },
});
```

其中 `...` 保留默认排除项，再额外排除这个配置文件。如果已有源码范围配置，请将这条排除项合并进去。已有 `scope.source.exclude` 数组时，只需向其中添加 `limina.config.mts`。也可以选择让合适的 `tsconfig` 包含该文件，再运行检查。

### 已有项目引用时 {#已有项目引用时先迁移}

如果**直接包含源码**的 `tsconfig` 手写了原生 `references`，需要先整理这些配置。使用与 `limina` 来自同一份源码构建的独立 `limina-migrate` 包。以下假设项目与源码目录同级，在 pnpm 工作区根目录运行：

```sh
pnpm add -D -w file:../limina/packages/migrate/dist
pnpm exec limina-migrate --dry-run --yes
```

单包项目安装时去掉 `-w`，并按实际位置调整路径。先阅读预览中的范围和写入计划。预览不会由迁移器写入项目文件，但配置模块本身仍会执行。准备好后再运行 `pnpm exec limina-migrate`，查看结果并运行 `pnpm exec limina check`。迁移不会替代完整检查，也不保证与原生 `tsc -b` 等价。适用条件、写入和恢复方式见[迁移说明](./cli.md#limina-migration)。

### 使用 Vue、Astro 或 Svelte {#使用-vue-astro-或-svelte}

自动选择框架检查器和选择需要覆盖的源码文件是两件事。默认源码范围**不包含** `.vue`、`.astro` 或 `.svelte` 文件，需要时应显式添加。如果受管 `tsconfig` 已经包含 Vue 组件，但 Limina 的源码范围没有包含它们，覆盖检查可能报告范围不一致。此时需要让两边描述的文件范围相符。

例如，已有 Vue 和 TypeScript 的单包项目想让 `src/App.vue` 参与检查，可以按以下步骤操作：

1. 在检查器的执行作用域安装受支持的 `vue-tsc`。以下版本适用于当前源码版本。如果项目是 pnpm 工作区，安装位置还应符合项目的依赖管理方式：

   ```sh
   pnpm add -D vue-tsc@3.2.4
   ```

2. 让负责 Vue 源码的 `tsconfig` 包含组件。以下片段只展示 `include`，请保留现有编译选项和其他必要模式。如果 `tsconfig.json` 是聚合入口，应修改它引用的 Vue 源码配置：

   ```json
   {
     "include": ["src/**/*.ts", "src/**/*.vue"]
   }
   ```

3. 在 Limina 配置中把 Vue 文件加入期望覆盖的源码范围：

   `limina.config.mjs`：

   ```js
   import { defineConfig } from 'limina';

   export default defineConfig({
     scope: {
       source: {
         include: ['...', '**/*.vue'],
       },
     },
   });
   ```

然后运行 `pnpm exec limina check`，检查报告中的覆盖结果和 `vue-tsc` 构建结果。`...` 保留默认 TypeScript 文件匹配模式。Vue 使用 `checker:build`。没有 Astro 或 Svelte 目标时，`checker:typecheck` 显示 `disabled` 并不表示 Vue 检查被跳过。

::: details Vue 检查失败时

如果 `proof:check` 报告 `App.vue` 未被覆盖，先检查负责 Vue 源码的 `tsconfig` 是否包含该文件。如果报告源码边界不一致，则对照 `scope.source` 和 `tsconfig` 包含的文件。覆盖检查通过，并不代表组件的类型检查也已通过。

如果 `checker:build` 失败，但摘要没有显示具体编译错误，可以运行 `pnpm exec limina checker build`，重新执行内部声明构建并查看检查器输出。这个命令可能写入 `.limina/`，不会执行生产构建。详见[故障排查](./troubleshooting.md#checker-build-diagnostics)。

:::

Astro 或 Svelte 项目可按需要加入 `**/*.astro` 或 `**/*.svelte`，并让各自的框架配置覆盖相应文件。它们需要不同的检查器依赖。Astro 还需要提前生成类型。依赖位置、受支持版本和前置步骤见[检查器配置](./config/checkers.md#框架前置条件)。`scope.source` 不会单独改变框架检查器自己的文件选择。

## 看懂检查结果并继续

默认 `limina check` 会检查项目引用关系、源码归属和包导入、预期源码的检查覆盖，并运行适用的检查器。它不包含包检查或发布检查。任务可以并发执行，结果和状态的区别见[内置任务](./built-in-tasks.md)。

失败时先看任务名称、问题代码和文件路径，再查看[故障排查](./troubleshooting.md)。想调整哪些包、文件和检查器参与，先读[配置参考](./config/index.md)。要了解为什么需要这些约束，读[为什么需要 Limina](./why.md)。

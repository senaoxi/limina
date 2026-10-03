# 覆盖证明允许清单

允许清单条目是显式源码覆盖例外。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  proof: {
    allowlist: [
      {
        file: 'src/generated/runtime.d.ts',
        reason: '由运行时构建步骤生成。',
      },
    ],
  },
});
```

## `allowlist`

- **类型：** `Array<{ file: string; reason: string }>`

每个条目指定一个源码文件，并说明它不纳入普通检查器覆盖的理由。逐文件声明例外，便于评审。

```js
proof: {
  allowlist: [
    {
      file: 'src/generated/runtime.d.ts',
      reason: '由运行时构建步骤生成。',
    },
  ],
}
```

## `file`

- **类型：** `string`

`file` 是允许例外的源码文件路径，相对于 `config.rootDir`。外部激活包可以使用 `../`；它必须指向已验证源码边界内、尚无检查器或图覆盖的现有具体文件，不应该用模糊通配模式扩大例外范围。文件不存在、已在边界之外或无需允许清单就已有覆盖时，都会报告无效条目；恢复普通覆盖后应移除例外。

## `reason`

- **类型：** `string`

`reason` 说明该文件不纳入普通检查器覆盖的理由。

::: warning 注意
`reason` 不能为空。应说明文件需要这一覆盖例外的原因，供后续评审。
:::

例如某个声明文件只由构建步骤生成：

```ts
// src/generated/runtime.d.ts
declare const runtimeVersion: string;
```

如果它落在 `config.source.include` 范围内，却不属于任何检查器入口，`limina proof check` 会将它报告为未覆盖源码。加到 `proof.allowlist` 后，它会被记录为覆盖例外，理由保留在配置中供评审。

::: details 示例目录
目录可以是：

```text
packages/core/
  src/index.ts
  src/generated/runtime.d.ts
  tsconfig.lib.json
```

`src/generated/runtime.d.ts` 在 `config.source.include` 范围内，但它不是由本仓库源码维护，而是构建步骤写出的声明文件。运行 `pnpm exec limina proof check` 时，Limina 会发现这个文件没有被检查器入口覆盖，于是把它报告为未覆盖源码。

把它加入允许清单后：

```js
proof: {
  allowlist: [
    {
      file: 'packages/core/src/generated/runtime.d.ts',
      reason: '由运行时构建步骤生成。',
    },
  ],
}
```

覆盖证明检查接受这一覆盖例外，并在配置中保留 `reason`。文件覆盖情况变化时，应重新评审该条目。
:::

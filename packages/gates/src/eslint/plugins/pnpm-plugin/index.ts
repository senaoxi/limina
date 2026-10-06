import type { ESLint, Rule } from 'eslint';
import nativePnpmPlugin from 'eslint-plugin-pnpm';
import { type AST, getStaticYAMLValue } from 'yaml-eslint-parser';

const unusedCatalogRule = nativePnpmPlugin.rules?.[
  'yaml-no-unused-catalog-item'
] as Rule.RuleModule | undefined;
if (!unusedCatalogRule) {
  throw new Error('The pnpm unused catalog rule is unavailable.');
}

// pnpm permits catalog references in parent/version-qualified overrides.
// The upstream rule counts the whole selector as the catalog package name.
export const pnpmPlugin: ESLint.Plugin = {
  ...nativePnpmPlugin,
  rules: {
    ...nativePnpmPlugin.rules,
    'yaml-no-unused-catalog-item': {
      ...unusedCatalogRule,
      create(context) {
        const workspace = getStaticYAMLValue(
          context.sourceCode.ast as unknown as AST.YAMLProgram,
        ) as { overrides?: Record<string, unknown> } | null;
        const references = new Set<string>();
        const overrides = Object.entries(workspace?.overrides ?? {});
        for (const [selector, value] of overrides) {
          if (typeof value !== 'string' || !value.startsWith('catalog:'))
            continue;
          const child = selector.split('>').at(-1)!;
          const versionPosition = child.lastIndexOf('@');
          const name =
            versionPosition > 0 ? child.slice(0, versionPosition) : child;
          references.add(`${name}:${value.slice(8) || 'default'}`);
        }
        const adapter = Object.create(context, {
          report: {
            value(descriptor: Rule.ReportDescriptor) {
              if (
                'messageId' in descriptor &&
                descriptor.messageId === 'unusedCatalogItem' &&
                typeof descriptor.data?.catalogItem === 'string' &&
                references.has(descriptor.data.catalogItem)
              ) {
                return;
              }
              context.report(descriptor);
            },
          },
        }) as Rule.RuleContext;
        return unusedCatalogRule.create(adapter);
      },
    },
  },
};

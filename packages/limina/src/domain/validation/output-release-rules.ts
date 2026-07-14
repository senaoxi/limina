import { identifier } from '../shared/identifiers';
import type { TypedValidatorRegistration } from './contracts';
import type {
  PackageOutputValidationView,
  ReleaseAssessmentValidationView,
} from './views';

export const packageOutputFindingRule: TypedValidatorRegistration<
  'package-output',
  PackageOutputValidationView,
  undefined,
  'finding'
> = {
  descriptor: Object.freeze({
    category: 'package-output',
    defaultSeverity: 'error',
    description: 'Reports classified package output findings.',
    documentation: {
      url: 'https://docs.senao.me/docs-islands/limina/config/package-checks',
    },
    id: identifier<'RuleId'>('package-output/classified-finding'),
    inputKind: 'package-output',
    messages: {
      finding: {
        text: 'Package {packageId} failed output policy {code}.',
        title: 'Package output policy failed',
      },
    },
    options: { kind: 'none' } as const,
  }),
  validate(view, context) {
    for (const finding of view.findings) {
      context.report({
        messageId: 'finding',
        values: { code: finding.code, packageId: finding.packageId },
      });
    }
  },
};

export const releaseAssessmentFindingRule: TypedValidatorRegistration<
  'release-assessment',
  ReleaseAssessmentValidationView,
  undefined,
  'finding'
> = {
  descriptor: Object.freeze({
    category: 'release',
    defaultSeverity: 'error',
    description: 'Reports classified release assessment findings.',
    documentation: {
      url: 'https://docs.senao.me/docs-islands/limina/config/release-checks',
    },
    id: identifier<'RuleId'>('release/classified-finding'),
    inputKind: 'release-assessment',
    messages: {
      finding: {
        text: 'Package {packageId} failed release policy {code}.',
        title: 'Release policy failed',
      },
    },
    options: { kind: 'none' } as const,
  }),
  validate(view, context) {
    for (const finding of view.findings) {
      context.report({
        messageId: 'finding',
        values: { code: finding.code, packageId: finding.packageId },
      });
    }
  },
};

import { createElapsedTimer } from 'logaria/helper';
import fs from 'node:fs';
import type { Plugin } from 'rolldown';
import type { Dependency } from 'rollup-plugin-license';
import license from 'rollup-plugin-license';
import { createLogger } from './logger.js';

type LoadPlugin = Plugin['load'];
type GetHandler<T> = T extends { handler: infer H } ? H : T;
type PluginContext = ThisParameterType<GetHandler<NonNullable<LoadPlugin>>>;

const LicenseLogger = createLogger({
  main: '@limina/build-tools',
}).getLoggerByGroup('plugin.license');

// Keep in sync with github ci workflow: https://github.com/senaoxi/docs-islands/blob/main/.github/workflows/dependency-review.yml
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MPL-2.0',
]);

export default function licensePlugin(
  licenseFilePath: string,
  licenseTitle: string,
  packageName: string,
  coreLicenseFilePath: string,
): Plugin {
  const updateElapsed = createElapsedTimer();
  const originalPlugin = license({
    thirdParty(dependencies) {
      // https://github.com/rollup/rollup/blob/master/build-plugins/generate-license-file.js
      // MIT Licensed https://github.com/rollup/rollup/blob/master/LICENSE-CORE.md
      const coreLicense = fs.readFileSync(coreLicenseFilePath, 'utf8');

      const deps = sortDependencies(dependencies);
      const licenses = sortLicenses(
        new Set(
          dependencies.map((dep) => dep.license).filter(Boolean) as string[],
        ),
      );
      const prohibitedLicenses = licenses.filter(
        (license) => !ALLOWED_LICENSES.has(license),
      );

      if (prohibitedLicenses.length > 0) {
        throw new Error(
          `Prohibited licenses: ${prohibitedLicenses.join(', ')}`,
        );
      }

      let dependencyLicenseTexts = '';
      for (let i = 0; i < deps.length; i++) {
        // Find dependencies with the same license text so it can be shared.
        const licenseText = deps[i].licenseText;
        const sameDeps = [deps[i]];
        if (licenseText) {
          for (let j = i + 1; j < deps.length; j++) {
            if (licenseText === deps[j].licenseText) {
              sameDeps.push(...deps.splice(j, 1));
              j--;
            }
          }
        }

        let text = `## ${sameDeps.map((d) => d.name).join(', ')}\n\n`;
        const depInfos = sameDeps.map((d) => getDependencyInformation(d));

        text += formatDependencyInfosText(depInfos);

        if (licenseText) {
          text += `\n${licenseText
            .trim()
            .replaceAll(/\r\n|\r/g, '\n')
            .split('\n')
            .map((line) => (line.length > 0 ? `> ${line}` : '>'))
            .join('\n')}\n`;
        }

        if (i !== deps.length - 1) {
          text += '\n---------------------------------------\n\n';
        }

        dependencyLicenseTexts += text;
      }

      const bundledLicensesText =
        licenses.length > 0 ? `\n${licenses.join(', ')}\n` : '';
      const bundledDependenciesText =
        dependencyLicenseTexts.length > 0 ? `\n${dependencyLicenseTexts}` : '';
      const licenseText =
        normalizeGeneratedLicenseText(`<!-- markdownlint-disable MD003 MD009 MD025 MD035 MD026 -->
# ${licenseTitle}

${packageName} is released under the MIT license:

${coreLicense}
# Licenses of bundled dependencies

The published ${packageName} artifact additionally contains code with the following licenses:
${bundledLicensesText}
# Bundled dependencies:${bundledDependenciesText}
`);

      const existingLicenseText = fs.existsSync(licenseFilePath)
        ? fs.readFileSync(licenseFilePath, 'utf8')
        : undefined;
      if (existingLicenseText !== licenseText) {
        LicenseLogger.info('LICENSE.md update started');
        fs.writeFileSync(licenseFilePath, licenseText);
        LicenseLogger.success(
          'LICENSE.md updated. You should commit the updated file.',
          updateElapsed(),
        );
      }
    },
  }) as Plugin;

  // Skip for watch mode.
  for (const hook of ['renderChunk', 'generateBundle'] as const) {
    const originalHook = originalPlugin[hook]!;
    originalPlugin[hook] = function (this: PluginContext, ...args: unknown[]) {
      if (this.meta.watchMode) return null;
      return (originalHook as Function).apply(this, args);
    };
  }
  return originalPlugin;
}

function sortDependencies(dependencies: Dependency[]) {
  return dependencies.toSorted(({ name: nameA }, { name: nameB }) => {
    return nameA! > nameB! ? 1 : nameB! > nameA! ? -1 : 0;
  });
}

function sortLicenses(licenses: Set<string>) {
  let withParenthesis: string[] = [];
  let noParenthesis: string[] = [];
  for (const license of licenses) {
    if (license[0] === '(') {
      withParenthesis.push(license);
    } else {
      noParenthesis.push(license);
    }
  }
  withParenthesis = withParenthesis.toSorted();
  noParenthesis = noParenthesis.toSorted();
  return [...noParenthesis, ...withParenthesis];
}

interface DependencyInfo {
  license?: string;
  names?: string;
  repository?: string;
}

function getDependencyInformation(dep: Dependency): DependencyInfo {
  const info: DependencyInfo = {};
  const { license, author, maintainers, contributors, repository } = dep;

  if (license) {
    info.license = license;
  }

  const names = new Set<string>();
  for (const person of [author, ...maintainers, ...contributors]) {
    const name = typeof person === 'string' ? person : person?.name;
    if (name) {
      names.add(name);
    }
  }
  if (names.size > 0) {
    info.names = [...names].join(', ');
  }

  if (repository) {
    info.repository =
      typeof repository === 'string' ? repository : repository.url;
  }

  return info;
}

function formatDependencyInfosText(depInfos: DependencyInfo[]): string {
  // If all same dependencies have the same license and contributor names, show them only once.
  if (
    depInfos.length > 1 &&
    depInfos.every(
      (info) =>
        info.license === depInfos[0].license &&
        info.names === depInfos[0].names,
    )
  ) {
    let text = '';
    const { license, names } = depInfos[0];
    const repositoryText = depInfos
      .map((info) => info.repository)
      .filter(Boolean)
      .join(', ');

    if (license) text += `License: ${license}\n`;
    if (names) text += `By: ${names}\n`;
    if (repositoryText) text += `Repositories: ${repositoryText}\n`;
    return text;
  }

  // Else show each dependency separately.
  let text = '';
  for (let j = 0; j < depInfos.length; j++) {
    const { license, names, repository } = depInfos[j];

    if (license) text += `License: ${license}\n`;
    if (names) text += `By: ${names}\n`;
    if (repository) text += `Repository: ${repository}\n`;
    if (j !== depInfos.length - 1) text += '\n';
  }
  return text;
}

function normalizeGeneratedLicenseText(text: string): string {
  return `${text.replaceAll(/[\t ]+$/gm, '').replace(/\n+$/u, '')}\n`;
}

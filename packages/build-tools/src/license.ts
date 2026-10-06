import {
  type BundledDependency,
  collectBundledDependencies,
} from '@limina/gates/license-policy';
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

export default function licensePlugin(
  licenseFilePath: string,
  licenseTitle: string,
  packageName: string,
  coreLicenseFilePath: string,
): Plugin {
  const updateElapsed = createElapsedTimer();
  let bundledDependencies: BundledDependency[] = [];
  const originalPlugin = license({
    thirdParty(dependencies) {
      bundledDependencies = collectBundledDependencies(dependencies);
      // https://github.com/rollup/rollup/blob/master/build-plugins/generate-license-file.js
      // MIT Licensed https://github.com/rollup/rollup/blob/master/LICENSE-CORE.md
      const coreLicense = fs.readFileSync(coreLicenseFilePath, 'utf8');

      const dependencies_ = sortDependencies(dependencies);
      const licenses = sortLicenses(
        new Set(
          dependencies
            .map((dependency) => dependency.license)
            .filter(Boolean) as string[],
        ),
      );
      let dependencyLicenseTexts = '';
      for (let index = 0; index < dependencies_.length; index++) {
        // Find dependencies with the same license text so it can be shared.
        const licenseText = dependencies_[index].licenseText;
        const sameDependencies = [dependencies_[index]];
        if (licenseText) {
          for (
            let index_ = index + 1;
            index_ < dependencies_.length;
            index_++
          ) {
            if (licenseText !== dependencies_[index_].licenseText) {
              continue;
            }

            sameDependencies.push(...dependencies_.splice(index_, 1));
            index_--;
          }
        }

        let text = `## ${sameDependencies.map((d) => d.name).join(', ')}\n\n`;
        const dependencyInfos = sameDependencies.map((d) =>
          getDependencyInformation(d),
        );

        text += formatDependencyInfosText(dependencyInfos);

        if (licenseText) {
          text += `\n${licenseText
            .trim()
            .replaceAll(/\r\n|\r/g, '\n')
            .split('\n')
            .map((line) => (line.length > 0 ? `> ${line}` : '>'))
            .join('\n')}\n`;
        }

        if (index !== dependencies_.length - 1) {
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
      if (existingLicenseText === licenseText) {
        return;
      }

      LicenseLogger.info('LICENSE.md update started');
      fs.writeFileSync(licenseFilePath, licenseText);
      LicenseLogger.success(
        'LICENSE.md updated. You should commit the updated file.',
        updateElapsed(),
      );
    },
  }) as Plugin;

  // Skip for watch mode.
  const originalRenderChunk = originalPlugin.renderChunk!;
  originalPlugin.renderChunk = function (
    this: PluginContext,
    ...arguments_: unknown[]
  ) {
    return this.meta.watchMode
      ? null
      : (originalRenderChunk as Function).apply(this, arguments_);
  };
  const originalGenerateBundle = originalPlugin.generateBundle!;
  originalPlugin.generateBundle = function (
    this: PluginContext,
    ...arguments_: unknown[]
  ) {
    if (this.meta.watchMode) return null;
    const result = (originalGenerateBundle as Function).apply(this, arguments_);
    this.emitFile({
      type: 'asset',
      fileName: 'bundled-dependencies.json',
      source: `${JSON.stringify({ packageName, dependencies: bundledDependencies }, null, 2)}\n`,
    });
    return result;
  };
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
  withParenthesis = withParenthesis.toSorted(
    (left, right) => Number(left > right) - Number(left < right),
  );
  noParenthesis = noParenthesis.toSorted(
    (left, right) => Number(left > right) - Number(left < right),
  );
  return [...noParenthesis, ...withParenthesis];
}

interface DependencyInfo {
  license?: string;
  names?: string;
  repository?: string;
}

function getDependencyInformation(dependency: Dependency): DependencyInfo {
  const info: DependencyInfo = {};
  const { license, author, maintainers, contributors, repository } = dependency;

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

function formatDependencyInfosText(dependencyInfos: DependencyInfo[]): string {
  // If all same dependencies have the same license and contributor names, show them only once.
  if (
    dependencyInfos.length > 1 &&
    dependencyInfos.every(
      (info) =>
        info.license === dependencyInfos[0].license &&
        info.names === dependencyInfos[0].names,
    )
  ) {
    let text = '';
    const { license, names } = dependencyInfos[0];
    const repoText = dependencyInfos
      .map((info) => info.repository)
      .filter(Boolean)
      .join(', ');

    if (license) text += `License: ${license}\n`;
    if (names) text += `By: ${names}\n`;
    if (repoText) text += `Repositories: ${repoText}\n`;
    return text;
  }

  // Else show each dependency separately.
  let text = '';
  for (let index = 0; index < dependencyInfos.length; index++) {
    const { license, names, repository } = dependencyInfos[index];

    if (license) text += `License: ${license}\n`;
    if (names) text += `By: ${names}\n`;
    if (repository) text += `Repository: ${repository}\n`;
    if (index !== dependencyInfos.length - 1) text += '\n';
  }
  return text;
}

function normalizeGeneratedLicenseText(text: string): string {
  return `${text.replaceAll(/[\t ]+$/gm, '').replace(/\n+$/u, '')}\n`;
}

function readPackage(package_) {
  if (!package_.name) {
    return package_;
  }

  /**
   * .
   * └─┬ vitepress 1.6.3
   *   └─┬ @docsearch/js 3.8.2
   *     └─┬ @docsearch/react 3.8.2
   *       ├── ✕ missing peer search-insights@">= 1 < 3"
   *       └─┬ @algolia/autocomplete-core 1.17.7
   *         └─┬ @algolia/autocomplete-plugin-algolia-insights 1.17.7
   *           └── ✕ missing peer search-insights@">= 1 < 3"
   *
   * I don't want to install the search-insights peer dependency at the root directory
   * for vitepress, installing it within vitepress's node_modules directory is sufficient.
   */
  if (package_.name.startsWith('vitepress')) {
    package_.dependencies = {
      ...package_.dependencies,
      'search-insights': '>= 1 < 3',
    };
  }

  // Both Vue compiler declaration files import Babel types. With hoist=false,
  // each compiler needs its own dependency, matching the Babel parser version.
  if (
    package_.name === '@vue/compiler-core' ||
    package_.name === '@vue/compiler-sfc'
  ) {
    package_.dependencies = {
      ...package_.dependencies,
      '@babel/types':
        package_.dependencies['@babel/types'] ??
        package_.dependencies['@babel/parser'],
    };
  }

  return package_;
}

module.exports = {
  hooks: {
    readPackage,
  },
};

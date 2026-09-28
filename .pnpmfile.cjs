function readPackage(pkg) {
  if (!pkg.name) {
    return pkg;
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
  if (pkg.name.startsWith('vitepress')) {
    pkg.dependencies = {
      ...pkg.dependencies,
      'search-insights': '>= 1 < 3',
    };
  }

  if (pkg.name === '@html-eslint/eslint-plugin') {
    pkg.dependencies = {
      ...pkg.dependencies,
      '@html-eslint/parser': '*',
    };
  }

  // Both Vue compiler declaration files import Babel types. With hoist=false,
  // each compiler needs its own dependency, matching the Babel parser version.
  if (pkg.name === '@vue/compiler-core' || pkg.name === '@vue/compiler-sfc') {
    pkg.dependencies = {
      ...pkg.dependencies,
      '@babel/types':
        pkg.dependencies['@babel/types'] ?? pkg.dependencies['@babel/parser'],
    };
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};

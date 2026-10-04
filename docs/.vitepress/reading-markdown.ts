import type { MarkdownRenderer } from 'vitepress';

/**
 * Keep table semantics in Markdown; the component owns overflow and its lifecycle.
 */
export function configureReadingMarkdown(md: MarkdownRenderer): void {
  md.renderer.rules.table_open = (
    tokens,
    index,
    options,
    _environment,
    renderer,
  ) => {
    const end = tokens.findIndex(
      (token, position) => position > index && token.type === 'thead_close',
    );
    const columns = tokens
      .slice(index, end)
      .filter((token) => token.type === 'th_open').length;
    return `<ReadingTable :wide="${columns >= 6}">\n${renderer.renderToken(tokens, index, options)}`;
  };
  md.renderer.rules.table_close = (
    tokens,
    index,
    options,
    _environment,
    renderer,
  ) => `${renderer.renderToken(tokens, index, options)}</ReadingTable>\n`;
  md.renderer.rules.th_open = (
    tokens,
    index,
    options,
    _environment,
    renderer,
  ) => {
    tokens[index]?.attrSet('scope', 'col');
    return renderer.renderToken(tokens, index, options);
  };
}

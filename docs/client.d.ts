declare module '*.css' {
  const source: string;
  export default source;
}

declare module '*.json?url' {
  const source: string;
  export default source;
}

interface ImportMeta {
  glob(
    pattern: string,
    options: { eager?: false; import: 'default'; query?: '?url' },
  ): Record<string, () => Promise<unknown>>;
  glob(
    pattern: string,
    options: { eager: true; import: 'default'; query?: '?url' },
  ): Record<string, unknown>;
}

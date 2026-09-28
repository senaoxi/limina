const virtualModulePrefixes = ['\0', 'virtual:', 'astro:', '$app/', '$env/'];

export function isKnownFrameworkVirtualSpecifier(specifier: string): boolean {
  return (
    virtualModulePrefixes.some((prefix) => specifier.startsWith(prefix)) ||
    specifier === '$service-worker'
  );
}

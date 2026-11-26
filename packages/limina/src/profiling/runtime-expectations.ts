import path from 'pathe';
import {
  collectRuntimeTreeIdentity,
  type RuntimeTreeIdentity,
} from './identity';

const SHA256_PATTERN = /^[a-f\d]{64}$/u;

interface ProfileRuntimeExpectations {
  executablePath?: string;
  packagePath?: string;
  runtimeTreeHash?: string;
}

function readOptionalEnvironment(name: string): string | undefined {
  const value = process.env[name];

  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function assertSha256Hash(name: string, value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash.`);
  }
}

function parseExpectedHash(
  name: string,
  configuredValue: string | undefined,
): string | undefined {
  if (configuredValue === undefined) {
    return undefined;
  }

  const value = configuredValue.toLowerCase();
  assertSha256Hash(name, value);
  return value;
}

function assertExpectedValue(options: {
  actual: string;
  expected: string | undefined;
  label: string;
}): void {
  if (options.expected === undefined) {
    return;
  }

  if (options.actual !== options.expected) {
    throw new Error(
      `${options.label} mismatch: expected ${options.expected}, received ${options.actual}.`,
    );
  }
}

function readExpectedPath(name: string): string | undefined {
  const value = readOptionalEnvironment(name);
  return value === undefined ? undefined : path.resolve(value);
}

function assertExpectedIdentity(
  identity: RuntimeTreeIdentity,
  expected: ProfileRuntimeExpectations,
): void {
  assertExpectedValue({
    actual: identity.treeHash,
    expected: parseExpectedHash(
      'LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH',
      expected.runtimeTreeHash,
    ),
    label: 'Linked Limina runtime tree hash',
  });
  assertExpectedValue({
    actual: identity.packageRealPath,
    expected: expected.packagePath,
    label: 'Linked Limina package realpath',
  });
  assertExpectedValue({
    actual: identity.executableRealPath,
    expected: expected.executablePath,
    label: 'Linked Limina executable realpath',
  });
}

export function readProfileRuntimeExpectations():
  | ProfileRuntimeExpectations
  | undefined {
  const executablePath = readExpectedPath(
    'LIMINA_PROFILE_EXPECTED_EXECUTABLE_REALPATH',
  );
  const packagePath = readExpectedPath(
    'LIMINA_PROFILE_EXPECTED_PACKAGE_REALPATH',
  );
  const runtimeTreeHash = readOptionalEnvironment(
    'LIMINA_PROFILE_EXPECTED_RUNTIME_TREE_HASH',
  );
  return executablePath === undefined &&
    packagePath === undefined &&
    runtimeTreeHash === undefined
    ? undefined
    : { executablePath, packagePath, runtimeTreeHash };
}

export async function qualifyProfileRuntime(
  expected: ProfileRuntimeExpectations,
): Promise<RuntimeTreeIdentity> {
  const executableLogicalPath = path.resolve(process.argv[1] ?? '');
  const packageLogicalPath = path.dirname(path.dirname(executableLogicalPath));
  const runtime = await collectRuntimeTreeIdentity({
    executableLogicalPath,
    packageLogicalPath,
  });
  assertExpectedIdentity(runtime, expected);
  return runtime;
}

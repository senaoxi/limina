import type {
  ArchitectureValidationInputKind,
  RuleDescriptor,
  TypedValidatorRegistration,
} from '../../domain/validation/contracts';
import type { ValidationViewByKind } from '../../domain/validation/views';

interface RegistrationDescriptorValue {
  readonly id: string;
  readonly inputKind: string;
}

interface RegistrationValue {
  readonly descriptor: RegistrationDescriptorValue;
  readonly validate: (...args: never[]) => unknown;
}

export function defineArchitectureValidator<
  Kind extends ArchitectureValidationInputKind,
  Options,
  MessageId extends string,
>(
  descriptor: RuleDescriptor<Kind, Options, MessageId>,
  validate: TypedValidatorRegistration<
    Kind,
    ValidationViewByKind[Kind],
    Options,
    MessageId
  >['validate'],
): TypedValidatorRegistration<
  Kind,
  ValidationViewByKind[Kind],
  Options,
  MessageId
> {
  return Object.freeze({ descriptor, validate });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function hasStringProperty(
  value: Record<string, unknown>,
  property: string,
): boolean {
  return typeof value[property] === 'string';
}

function isRegistrationDescriptor(
  value: unknown,
): value is RegistrationDescriptorValue {
  if (!isObjectRecord(value)) {
    return false;
  }

  return ['id', 'inputKind'].every((property) =>
    hasStringProperty(value, property),
  );
}

function hasRegistrationShape(value: unknown): value is {
  readonly descriptor: unknown;
  readonly validate: (...args: never[]) => unknown;
} {
  return isObjectRecord(value) && typeof value.validate === 'function';
}

function assertRegistration(
  value: unknown,
): asserts value is RegistrationValue {
  if (!hasRegistrationShape(value)) {
    throw new Error(
      'Validator registry entries require descriptor and validate.',
    );
  }

  if (!isRegistrationDescriptor(value.descriptor)) {
    throw new Error('Validator registry entries require a valid descriptor.');
  }
}

function assertUniqueRegistrationId(
  ids: Set<string>,
  registration: RegistrationValue,
): void {
  if (ids.has(registration.descriptor.id)) {
    throw new Error(
      `Duplicate validator rule id "${registration.descriptor.id}".`,
    );
  }

  ids.add(registration.descriptor.id);
}

export function createTypedValidatorRegistry<
  const Registrations extends readonly unknown[],
>(registrations: Registrations): Readonly<Registrations> {
  const ids = new Set<string>();

  for (const registration of registrations) {
    assertRegistration(registration);
    assertUniqueRegistrationId(ids, registration);
  }

  return Object.freeze([
    ...registrations,
  ]) as unknown as Readonly<Registrations>;
}

export function createArchitectureValidatorRegistry<
  const Registrations extends readonly unknown[],
>(registrations: Registrations): Readonly<Registrations> {
  return createTypedValidatorRegistry(registrations);
}

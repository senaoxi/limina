import type {
  ArchitectureValidationInputKind,
  RuleDescriptor,
  TypedValidatorRegistration,
} from '../../domain/validation/contracts';
import type { ValidationViewByKind } from '../../domain/validation/views';

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

function assertRegistration(value: unknown): asserts value is {
  readonly descriptor: { readonly id: string; readonly inputKind: string };
  readonly validate: (...args: never[]) => unknown;
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('descriptor' in value) ||
    !('validate' in value) ||
    typeof value.validate !== 'function'
  ) {
    throw new Error(
      'Validator registry entries require descriptor and validate.',
    );
  }

  const descriptor = value.descriptor;

  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    !('id' in descriptor) ||
    !('inputKind' in descriptor) ||
    typeof descriptor.id !== 'string' ||
    typeof descriptor.inputKind !== 'string'
  ) {
    throw new Error('Validator registry entries require a valid descriptor.');
  }
}

export function createTypedValidatorRegistry<
  const Registrations extends readonly unknown[],
>(registrations: Registrations): Readonly<Registrations> {
  const ids = new Set<string>();

  for (const registration of registrations) {
    assertRegistration(registration);

    if (ids.has(registration.descriptor.id)) {
      throw new Error(
        `Duplicate validator rule id "${registration.descriptor.id}".`,
      );
    }

    ids.add(registration.descriptor.id);
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

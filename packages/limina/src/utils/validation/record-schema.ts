import { isIntegerNumber } from './is-integer';
export type ValueValidator = (value: unknown) => boolean;

export type RecordSchema = Readonly<Record<string, ValueValidator>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMatchesRecordSchema(
  value: unknown,
  schema: RecordSchema,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.entries(schema).every(([field, validate]) => validate(value[field]))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isIntegerNumber(value) && Number(value) > 0;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

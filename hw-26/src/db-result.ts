/**
 * TypeORM + pg return SELECT rows as T[], but UPDATE/INSERT … RETURNING as [T[], rowCount].
 */
export function returningRows<T extends Record<string, unknown>>(
  result: T[] | [T[], number],
): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0];
  }
  return result as T[];
}

/** Apply an asynchronous projection after callers acquire the source Promise.
 * Keeping acquisition at the call site preserves synchronous provider failures.
 */
export async function mapPromise<T, R>(
  promise: Promise<T>,
  project: (value: T) => R | PromiseLike<R>,
): Promise<R> {
  return project(await promise);
}

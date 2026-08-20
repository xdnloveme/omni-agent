import type { RuntimeObservationScope } from "./ports";

export function iterateObserved<T, TReturn = void, TNext = unknown>(
  scope: RuntimeObservationScope,
  operation: () => AsyncIterable<T> | AsyncIterator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  const source = scope.run(operation);
  const iterator =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (source as AsyncIterator<T, TReturn, TNext>);
  const observed: AsyncIterator<T, TReturn, TNext> = {
    next: (...arguments_) => scope.run(() => iterator.next(...arguments_)),
    return: iterator.return
      ? (value) => scope.run(() => iterator.return!(value))
      : async (value) => ({ value: value as TReturn, done: true }),
    throw: iterator.throw
      ? (error) => scope.run(() => iterator.throw!(error))
      : async (error) => {
          throw error;
        },
  };
  return {
    ...observed,
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<T, TReturn, TNext>;
}

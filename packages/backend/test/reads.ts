// Counts the documents a function body reads, for the bounded-read checks
// (queryCost.test.ts). convex-test has no read counter, so the context's `db`
// is wrapped: `get` counts a found document, and a query's terminal calls
// (`first`, `unique`, `take`, `collect`, async iteration) count what they return.
import type { QueryCtx } from '../convex/_generated/server';

type Counter = { reads: number; tables: Record<string, number> };

function countingQuery(query: object, table: string, counter: Counter): unknown {
  const add = (n: number) => {
    counter.reads += n;
    counter.tables[table] = (counter.tables[table] ?? 0) + n;
  };
  return new Proxy(query, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === Symbol.asyncIterator)
        return () => {
          const iterator = (value as () => AsyncIterator<unknown>).call(target);
          return {
            next: async () => {
              const step = await iterator.next();
              if (!step.done) add(1);
              return step;
            },
          };
        };
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (prop === 'first' || prop === 'unique') return (result as Promise<unknown>).then((doc) => (add(doc ? 1 : 0), doc));
        if (prop === 'take' || prop === 'collect') return (result as Promise<unknown[]>).then((docs) => (add(docs.length), docs));
        // withIndex, filter, order, …: still a query.
        return result && typeof result === 'object' ? countingQuery(result, table, counter) : result;
      };
    },
  });
}

/** The context with a counting `db`, and the counter it adds to. */
export function countingReads<Ctx extends QueryCtx>(ctx: Ctx): { ctx: Ctx; counter: Counter } {
  const counter: Counter = { reads: 0, tables: {} };
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'get')
        return async (...args: unknown[]) => {
          const doc = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (doc) {
            counter.reads += 1;
            counter.tables.get = (counter.tables.get ?? 0) + 1;
          }
          return doc;
        };
      if (prop === 'query') return (table: string) => countingQuery((value as (t: string) => object).call(target, table), table, counter);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db } as Ctx, counter };
}

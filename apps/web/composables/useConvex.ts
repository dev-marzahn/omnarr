// Thin Vue bindings for the ConvexClient; there is no official Vue client.
// Argument and result types come from the backend's generated API, whose
// `returns` are @omnarr/contracts DTOs.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

/** A live query: re-runs when its data changes, and when `args` changes. `'skip'` runs nothing. */
export function useQuery<Query extends FunctionReference<'query'>>(query: Query, args: MaybeRefOrGetter<FunctionArgs<Query> | 'skip'>) {
  const { $convex } = useNuxtApp();
  const data = shallowRef<FunctionReturnType<Query>>();
  const error = shallowRef<Error>();

  let unsubscribe: (() => void) | undefined;
  watch(
    () => toValue(args),
    (value) => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (value === 'skip') {
        data.value = undefined;
        return;
      }
      unsubscribe = $convex.onUpdate(
        query,
        value,
        (result) => {
          data.value = result;
          error.value = undefined;
        },
        (e) => {
          error.value = e;
        },
      );
    },
    { immediate: true, deep: true },
  );
  onScopeDispose(() => unsubscribe?.());

  return { data, error, isLoading: computed(() => data.value === undefined && error.value === undefined) };
}

/** A query read once, on demand: a dialog's preview, not a live view. */
export function useQueryOnce<Query extends FunctionReference<'query'>>(query: Query) {
  const { $convex } = useNuxtApp();
  return (args: FunctionArgs<Query>): Promise<FunctionReturnType<Query>> => $convex.query(query, args);
}

export function useMutation<Mutation extends FunctionReference<'mutation'>>(mutation: Mutation) {
  const { $convex } = useNuxtApp();
  return (args: FunctionArgs<Mutation>): Promise<FunctionReturnType<Mutation>> => $convex.mutation(mutation, args);
}

/** Actions are the calls that leave Convex (metadata over HTTP). */
export function useAction<Action extends FunctionReference<'action'>>(action: Action) {
  const { $convex } = useNuxtApp();
  return (args: FunctionArgs<Action>): Promise<FunctionReturnType<Action>> => $convex.action(action, args);
}

/** The `code` of a ConvexError the backend threw, if it is one. */
export function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string' ? data.code : undefined;
}

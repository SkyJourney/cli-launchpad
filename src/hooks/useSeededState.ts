import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

const UNSEEDED = Symbol("unseeded");

/// Seed editable local state from async (react-query) data once per `resetKey`.
/// A background refetch (same resetKey) does not clobber in-progress edits;
/// changing `resetKey` re-seeds (e.g. switching directory). Pass a fresh
/// `resetKey` to force a re-seed.
export function useSeededState<S, T>(
  source: S | undefined,
  toState: (source: S) => T,
  initial: T,
  resetKey: unknown,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(initial);
  const seededFor = useRef<unknown>(UNSEEDED);

  useEffect(() => {
    if (source === undefined || seededFor.current === resetKey) {
      return;
    }
    seededFor.current = resetKey;
    setState(toState(source));
    // toState/initial are intentionally excluded; re-seed is driven by data/key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, resetKey]);

  return [state, setState];
}

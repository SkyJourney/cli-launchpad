import { useAppStore } from "../store/appStore";
import type { ResolvedTheme } from "../lib/themes";

export function useResolvedTheme(): ResolvedTheme {
  return useAppStore((state) => state.resolvedTheme);
}

export function subscribeResolvedTheme(
  listener: (theme: ResolvedTheme) => void,
): () => void {
  let previousTheme = useAppStore.getState().resolvedTheme;
  return useAppStore.subscribe((state) => {
    if (
      state.resolvedTheme.id === previousTheme.id &&
      state.resolvedTheme.base === previousTheme.base
    ) {
      return;
    }
    previousTheme = state.resolvedTheme;
    listener(previousTheme);
  });
}

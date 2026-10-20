/**
 * Shared start-up sequence of the detached content windows: register every
 * listener, stop if the window was unmounted meanwhile, keep the listeners for
 * cleanup, then run the window specific continuation (file window: send ready;
 * PTY window: attach the handoff, then send ready).
 */
export async function completeDetachedWindowSetup(args: {
  registerListeners: () => Promise<Array<() => void>>;
  isDisposed: () => boolean;
  keepListeners: (unlisteners: Array<() => void>) => void;
  afterListeners: () => Promise<void>;
}): Promise<boolean> {
  const unlisteners = await args.registerListeners();
  if (args.isDisposed()) {
    unlisteners.forEach((unlisten) => unlisten());
    return false;
  }

  args.keepListeners(unlisteners);
  if (args.isDisposed()) return false;
  await args.afterListeners();
  return true;
}

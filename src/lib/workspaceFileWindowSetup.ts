export async function completeWorkspaceFileWindowSetup(args: {
  registerListeners: () => Promise<Array<() => void>>;
  isDisposed: () => boolean;
  keepListeners: (unlisteners: Array<() => void>) => void;
  sendReady: () => Promise<void>;
}): Promise<boolean> {
  const unlisteners = await args.registerListeners();
  if (args.isDisposed()) {
    unlisteners.forEach((unlisten) => unlisten());
    return false;
  }

  args.keepListeners(unlisteners);
  if (args.isDisposed()) return false;
  await args.sendReady();
  return true;
}

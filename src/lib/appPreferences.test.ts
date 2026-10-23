// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { useAppStore } from "../store/appStore";
import { applyRemoteAppLanguage } from "../i18n";
import { applyRemotePreferences, isAppPreferences } from "./appPreferences";
import { onInboxEvent } from "./windowInbox";
import { listenForAppPreferences } from "./appPreferencesChild";
import { respondToAppPreferencesRequests } from "./appPreferencesMain";

describe("app preferences protocol", () => {
  beforeEach(async () => {
    useAppStore.getState().applyRemoteThemeMode("system");
    await applyRemoteAppLanguage("en");
    document.documentElement.dir = "ltr";
  });

  it("accepts only version 1 preferences with registered values", () => {
    expect(
      isAppPreferences({ apiVersion: 1, theme: "dark", language: "zh" }),
    ).toBe(true);
    expect(
      isAppPreferences({ apiVersion: 2, theme: "dark", language: "zh" }),
    ).toBe(false);
    expect(
      isAppPreferences({ apiVersion: 1, theme: "purple", language: "zh" }),
    ).toBe(false);
    expect(
      isAppPreferences({ apiVersion: 1, theme: "dark", language: "unknown" }),
    ).toBe(false);
  });

  it("applies remote preferences in memory without writing local storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    await applyRemotePreferences({
      apiVersion: 1,
      theme: "light",
      language: "ar",
    });

    expect(useAppStore.getState().themeMode).toBe("light");
    expect(document.documentElement.dir).toBe("rtl");
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it.each([
    "terminal-8e783338-f464-4b10-b15e-b534748c6241",
    "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
  ])(
    "answers the window that sent the preferences request through the relay: %s",
    async (label) => {
      tauriMock.setCurrentWindowLabel("main");
      await respondToAppPreferencesRequests(() => ({
        apiVersion: 1,
        theme: "dark",
        language: "ja",
      }));
      // The requesting window has subscribed its inbox.
      tauriMock.setCurrentWindowLabel(label);
      await onInboxEvent("window-message", vi.fn());
      tauriMock.setCurrentWindowLabel("main");

      tauriMock.deliverInbox(
        "main",
        "window-message",
        {
          apiVersion: 1,
          type: "app-preferences-requested",
          payload: { apiVersion: 1, windowLabel: label },
        },
        {
          label,
          kind: label.startsWith("terminal-") ? "terminal" : "workspaceContent",
        },
      );

      await vi.waitFor(() => {
        expect(tauriMock.state.relayedMessages).toContainEqual({
          from: "main",
          target: label,
          messageType: "app-preferences-reply",
          payload: {
            apiVersion: 1,
            type: "app-preferences-reply",
            payload: { apiVersion: 1, theme: "dark", language: "ja" },
          },
        });
      });
      // The reply is a relayed message, not a targeted event.
      expect(
        tauriMock.state.emittedEvents.some(
          (event) =>
            event.target === label && event.eventName === "app-preferences",
        ),
      ).toBe(false);
    },
  );

  it("does not answer a request whose claimed label differs from the stamped sender", async () => {
    tauriMock.setCurrentWindowLabel("main");
    await respondToAppPreferencesRequests(() => ({
      apiVersion: 1,
      theme: "dark",
      language: "en",
    }));
    const claimed = "terminal-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";
    const stamped = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(stamped);
    await onInboxEvent("window-message", vi.fn());
    tauriMock.setCurrentWindowLabel("main");
    const before = tauriMock.state.relayedMessages.length;

    tauriMock.deliverInbox(
      "main",
      "window-message",
      {
        apiVersion: 1,
        type: "app-preferences-requested",
        payload: { apiVersion: 1, windowLabel: claimed },
      },
      { label: stamped, kind: "terminal" },
    );

    await Promise.resolve();
    expect(tauriMock.state.relayedMessages).toHaveLength(before);

    // Reverse: a request whose claim equals the stamp is answered.
    tauriMock.deliverInbox(
      "main",
      "window-message",
      {
        apiVersion: 1,
        type: "app-preferences-requested",
        payload: { apiVersion: 1, windowLabel: stamped },
      },
      { label: stamped, kind: "terminal" },
    );
    await vi.waitFor(() =>
      expect(tauriMock.state.relayedMessages).toHaveLength(before + 1),
    );
  });

  it("keeps the broadcast listener when the relayed reply cannot be registered", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    const unlistenBroadcast = vi.fn();
    (
      tauriMock.getWindow(label).listen as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => unlistenBroadcast);
    tauriMock.failNextInboxSubscribe(new Error("subscribe failed"));
    const onPartialFailure = vi.fn();

    const stop = await listenForAppPreferences(vi.fn(), onPartialFailure);

    expect(onPartialFailure).toHaveBeenCalledTimes(1);
    expect(onPartialFailure).toHaveBeenCalledWith("reply", expect.any(Error));
    // The broadcast path stays registered until the caller stops listening.
    expect(unlistenBroadcast).not.toHaveBeenCalled();
    stop();
    expect(unlistenBroadcast).toHaveBeenCalledTimes(1);
  });

  it("keeps the relayed reply when the broadcast cannot be registered", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    (
      tauriMock.getWindow(label).listen as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      throw new Error("listen failed");
    });
    const onPreferences = vi.fn();
    const onPartialFailure = vi.fn();

    const stop = await listenForAppPreferences(onPreferences, onPartialFailure);

    expect(onPartialFailure).toHaveBeenCalledWith(
      "broadcast",
      expect.any(Error),
    );
    tauriMock.deliverInbox(
      label,
      "window-message",
      {
        apiVersion: 1,
        type: "app-preferences-reply",
        payload: { apiVersion: 1, theme: "dark", language: "ja" },
      },
      { label: "main", kind: "main" },
    );
    expect(onPreferences).toHaveBeenCalledWith({
      apiVersion: 1,
      theme: "dark",
      language: "ja",
    });
    stop();
  });

  it("rejects when neither the broadcast nor the relayed reply can be registered", async () => {
    const label = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    tauriMock.setCurrentWindowLabel(label);
    (
      tauriMock.getWindow(label).listen as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      throw new Error("listen failed");
    });
    tauriMock.failNextInboxSubscribe(new Error("subscribe failed"));
    const onPartialFailure = vi.fn();

    await expect(
      listenForAppPreferences(vi.fn(), onPartialFailure),
    ).rejects.toThrow();

    expect(onPartialFailure).not.toHaveBeenCalled();
  });
});

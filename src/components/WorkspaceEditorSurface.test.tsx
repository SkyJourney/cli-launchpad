// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../i18n";
import {
  registerWorkspaceEditorEngine,
  WorkspaceEditorSurface,
} from "./WorkspaceEditorSurface";
import {
  defaultEngineId,
  recordedEditorEngineId,
} from "./workspaceEditorEngineRegistry";

afterEach(cleanup);

describe("WorkspaceEditorSurface", () => {
  it("shows a placeholder when no default editor engine is registered", () => {
    render(
      <WorkspaceEditorSurface
        documentKey="document-1"
        value="text"
        relativePath="notes.txt"
        modelUri="file:///notes.txt"
        theme="dark"
        readOnly={false}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    expect(screen.getByRole("status").textContent).toBeTruthy();
  });

  it("records which engine renders the document so that it can be released later", () => {
    const dispose = registerWorkspaceEditorEngine({
      id: defaultEngineId,
      apiVersion: 1,
      releaseDocument: () => {},
      View: () => <div data-testid="engine" />,
    });

    try {
      render(
        <WorkspaceEditorSurface
          documentKey="document-recorded"
          value="text"
          relativePath="notes.txt"
          modelUri="file:///notes.txt"
          theme="dark"
          readOnly={false}
          onChange={() => {}}
          onSave={() => {}}
        />,
      );

      expect(screen.getByTestId("engine")).toBeTruthy();
      expect(recordedEditorEngineId("document-recorded")).toBe(defaultEngineId);
    } finally {
      dispose();
    }
  });
});

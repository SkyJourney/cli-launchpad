// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../i18n";
import { WorkspaceEditorSurface } from "./WorkspaceEditorSurface";

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
});

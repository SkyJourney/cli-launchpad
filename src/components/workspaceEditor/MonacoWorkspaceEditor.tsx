import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import cssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWorkspaceEditorLanguage } from "../../lib/workspaceEditorLanguage";
import {
  takeWorkspaceEditorModelUris,
  registerWorkspaceEditorModel,
} from "../../lib/workspaceEditorModelRegistry";

import "monaco-editor/features/anchorSelect/register.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/caretOperations/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/codeAction/register.js";
import "monaco-editor/features/comment/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/documentSymbols/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/format/register.js";
import "monaco-editor/features/gotoError/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/gotoSymbol/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/indentation/register.js";
import "monaco-editor/features/lineSelection/register.js";
import "monaco-editor/features/linesOperations/register.js";
import "monaco-editor/features/links/register.js";
import "monaco-editor/features/multicursor/register.js";
import "monaco-editor/features/quickOutline/register.js";
import "monaco-editor/features/rename/register.js";
import "monaco-editor/features/smartSelect/register.js";
import "monaco-editor/features/snippet/register.js";
import "monaco-editor/features/suggest/register.js";
import "monaco-editor/features/tokenization/register.js";
import "monaco-editor/features/toggleTabFocusMode/register.js";
import "monaco-editor/features/unicodeHighlighter/register.js";
import "monaco-editor/features/unusualLineTerminators/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/wordPartOperations/register.js";

loader.config({ monaco });

type MonacoWorkerEnvironment = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};

const workerGlobal = globalThis as MonacoWorkerEnvironment;
workerGlobal.MonacoEnvironment ??= {
  getWorker: (_moduleId, label) => {
    if (label === "json") return new jsonWorker();
    if (["css", "scss", "less"].includes(label)) return new cssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new htmlWorker();
    if (["typescript", "javascript"].includes(label)) return new tsWorker();
    return new editorWorker();
  },
};

const definitionLoaders: Record<string, () => Promise<unknown>> = {
  bat: () => import("monaco-editor/languages/definitions/bat/register.js"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/register.js"),
  csharp: () =>
    import("monaco-editor/languages/definitions/csharp/register.js"),
  css: () => import("monaco-editor/languages/definitions/css/register.js"),
  dart: () => import("monaco-editor/languages/definitions/dart/register.js"),
  dockerfile: () =>
    import("monaco-editor/languages/definitions/dockerfile/register.js"),
  go: () => import("monaco-editor/languages/definitions/go/register.js"),
  html: () => import("monaco-editor/languages/definitions/html/register.js"),
  java: () => import("monaco-editor/languages/definitions/java/register.js"),
  javascript: () =>
    import("monaco-editor/languages/definitions/javascript/register.js"),
  markdown: () =>
    import("monaco-editor/languages/definitions/markdown/register.js"),
  powershell: () =>
    import("monaco-editor/languages/definitions/powershell/register.js"),
  python: () =>
    import("monaco-editor/languages/definitions/python/register.js"),
  rust: () => import("monaco-editor/languages/definitions/rust/register.js"),
  shell: () => import("monaco-editor/languages/definitions/shell/register.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/register.js"),
  typescript: () =>
    import("monaco-editor/languages/definitions/typescript/register.js"),
  xml: () => import("monaco-editor/languages/definitions/xml/register.js"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/register.js"),
};

const languageFeatureLoaders: Record<string, () => Promise<unknown>> = {
  css: () => import("monaco-editor/languages/features/css/register.js"),
  html: () => import("monaco-editor/languages/features/html/register.js"),
  json: () => import("monaco-editor/languages/features/json/register.js"),
  javascript: () =>
    import("monaco-editor/languages/features/typescript/register.js"),
  typescript: () =>
    import("monaco-editor/languages/features/typescript/register.js"),
};

export function MonacoWorkspaceEditor({
  documentKey,
  value,
  relativePath,
  modelUri,
  theme,
  readOnly,
  onChange,
  onSave,
}: {
  documentKey: string;
  value: string;
  relativePath: string;
  modelUri: string;
  theme: "light" | "dark";
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const language = useMemo(
    () => resolveWorkspaceEditorLanguage(relativePath),
    [relativePath],
  );
  const [readyLanguage, setReadyLanguage] = useState("plaintext");
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await definitionLoaders[language]?.();
      await languageFeatureLoaders[language]?.();
      if (!cancelled) setReadyLanguage(language);
    };
    void load().catch((error) => {
      console.warn(
        `Unable to load Monaco language support for ${language}`,
        error,
      );
      if (!cancelled) setReadyLanguage("plaintext");
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const editorTheme = theme === "dark" ? "vs-dark" : "vs";
  return (
    <div className="workspace-editor-surface">
      <Editor
        height="100%"
        path={modelUri}
        language={readyLanguage}
        theme={editorTheme}
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        onMount={(editor, api) => {
          registerWorkspaceEditorModel(documentKey, modelUri);
          editor.addAction({
            id: "cli-launchpad.save-file",
            label: "Save File",
            keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyS],
            run: () => onSaveRef.current(),
          });
        }}
        options={{
          automaticLayout: true,
          readOnly,
          fontFamily: "Maple Mono NF CN, monospace",
          fontSize: 14,
          lineNumbers: "on",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: "selection",
          smoothScrolling: true,
        }}
      />
    </div>
  );
}

export function releaseMonacoWorkspaceDocument(documentKey: string): void {
  for (const modelUri of takeWorkspaceEditorModelUris(documentKey)) {
    monaco.editor.getModel(monaco.Uri.parse(modelUri))?.dispose();
  }
}

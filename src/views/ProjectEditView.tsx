import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useDirectory, useTools } from "../hooks/queries";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { useSeededState } from "../hooks/useSeededState";
import { getFlagValue, setFlagValue } from "../lib/args";
import { qk } from "../lib/queryKeys";
import { emptyToolMap, TOOLS } from "../lib/tools";
import {
  getDirectoryToolArgs,
  getModelCatalog,
  saveDirectoryToolArgsBatch,
  type DirectoryToolArgs,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

type ArgsMap = Record<ToolKey, string>;

function argsFromEntries(entries: DirectoryToolArgs[]): ArgsMap {
  const next = emptyToolMap();
  for (const entry of entries) {
    next[entry.toolKey] = entry.args;
  }
  return next;
}

export function ProjectEditView() {
  const { t } = useTranslation();
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const setView = useAppStore((state) => state.setView);
  const queryClient = useQueryClient();

  const directory = useDirectory(selectedDirectoryId);
  const directoryId = directory?.id ?? null;
  const { data: tools } = useTools();
  const statusByTool = indexByTool(useCliStatus().data);

  const savedArgs = useQuery({
    queryKey: qk.directoryToolArgs(directoryId),
    queryFn: () => getDirectoryToolArgs(directoryId as number),
    enabled: directoryId != null,
  });

  const modelCatalogs = useQueries({
    queries: TOOLS.map((tool) => ({
      queryKey: qk.modelCatalog(tool.key),
      queryFn: () => getModelCatalog(tool.key),
      enabled: (statusByTool[tool.key]?.status ?? "missing") === "available",
      staleTime: 10 * 60 * 1_000,
    })),
  });

  // Seed editable args from the saved values, re-seeding when the directory
  // changes; a background refetch won't clobber in-progress edits.
  const [args, setArgs] = useSeededState<DirectoryToolArgs[], ArgsMap>(
    savedArgs.data,
    argsFromEntries,
    emptyToolMap(),
    directoryId,
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const id = directoryId as number;
      // Skip missing tools: they are read-only in the UI; their existing DB
      // rows are preserved by not writing them.
      const editable = TOOLS.filter(
        (tool) => (statusByTool[tool.key]?.status ?? "missing") !== "missing",
      );
      await saveDirectoryToolArgsBatch(
        id,
        editable.map((tool) => ({
          toolKey: tool.key,
          args: args[tool.key].trim(),
        })),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: qk.directoryToolArgs(directoryId),
      });
      setView("detail");
    },
  });

  if (!directory) {
    return (
      <div className="edit-view">
        <button className="ghost-button" onClick={() => setView("projects")}>
          <ArrowLeft size={15} />
          {t("common.back")}
        </button>
        <p className="muted">{t("projectEdit.noDirectory")}</p>
      </div>
    );
  }

  const updateArgs = (toolKey: ToolKey, value: string) =>
    setArgs((prev) => ({ ...prev, [toolKey]: value }));

  return (
    <div className="edit-view">
      <button className="ghost-button" onClick={() => setView("detail")}>
        <ArrowLeft size={15} />
        {t("common.back")}
      </button>

      <header className="detail-head">
        <h1>{t("projectEdit.title", { name: directory.name })}</h1>
        <p className="muted">{directory.path}</p>
      </header>

      {TOOLS.map((tool, toolIndex) => {
        const status = statusByTool[tool.key]?.status ?? "missing";
        const disabled = status === "missing";
        const globalArgs =
          tools?.find((t) => t.key === tool.key)?.globalArgs ?? "";
        const globalModel = getFlagValue(globalArgs, "--model");
        const selectedModel = getFlagValue(args[tool.key], "--model");
        const modelCatalog = modelCatalogs[toolIndex];
        const options = modelCatalog.data?.options ?? [];
        const selectedIsKnown =
          selectedModel == null ||
          options.some((option) => option.value === selectedModel);
        return (
          <section
            key={tool.key}
            className={clsx("edit-section", { disabled })}
          >
            <div className="edit-section-head">
              <tool.icon size={18} />
              <strong>{tool.label}</strong>
              {disabled && (
                <span className="muted">{t("projectEdit.unavailable")}</span>
              )}
            </div>

            <div className="edit-field">
              <label className="muted">{t("projectEdit.globalArgs")}</label>
              <code className="readonly-args">
                {globalArgs || t("common.none")}
              </code>
            </div>

            <div className="edit-field">
              <div className="model-field-heading">
                <label className="muted">{t("projectEdit.launchModel")}</label>
                <button
                  className="icon-button refresh-button"
                  title={t("projectEdit.refreshModels", { tool: tool.label })}
                  disabled={disabled || modelCatalog.isFetching}
                  onClick={() =>
                    void queryClient.fetchQuery({
                      queryKey: qk.modelCatalog(tool.key),
                      queryFn: () => getModelCatalog(tool.key, true),
                    })
                  }
                >
                  <RefreshCw
                    size={14}
                    className={modelCatalog.isFetching ? "spinning" : undefined}
                  />
                </button>
              </div>
              <div className="model-select-row">
                <select
                  value={selectedModel ?? ""}
                  disabled={disabled || modelCatalog.isLoading}
                  onChange={(event) =>
                    updateArgs(
                      tool.key,
                      setFlagValue(
                        args[tool.key],
                        "--model",
                        event.target.value || null,
                      ),
                    )
                  }
                >
                  <option value="">
                    {globalModel
                      ? t("projectEdit.inheritGlobal", { model: globalModel })
                      : t("projectEdit.cliDefault")}
                  </option>
                  {!selectedIsKnown && selectedModel && (
                    <option value={selectedModel}>
                      {t("projectEdit.customModel", { model: selectedModel })}
                    </option>
                  )}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                      {option.isDefault ? t("projectEdit.recommended") : ""}
                    </option>
                  ))}
                </select>
                <input
                  value={selectedModel ?? ""}
                  disabled={disabled}
                  placeholder={t("projectEdit.modelPlaceholder")}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateArgs(
                      tool.key,
                      setFlagValue(
                        args[tool.key],
                        "--model",
                        value.trim() === "" ? null : value,
                      ),
                    );
                  }}
                />
              </div>
              {modelCatalog.isError ? (
                <span className="error model-catalog-note">
                  {t("projectEdit.modelFailed", {
                    error: String(modelCatalog.error),
                  })}
                </span>
              ) : modelCatalog.data ? (
                <span className="muted model-catalog-note">
                  {t("projectEdit.source", {
                    source: modelCatalog.data.source,
                  })}
                  {modelCatalog.data.fromCache
                    ? ` · ${t("projectEdit.cached")}`
                    : ""}
                </span>
              ) : (
                !disabled && (
                  <span className="muted model-catalog-note">
                    {t("projectEdit.readingModels")}
                  </span>
                )
              )}
              {modelCatalog.data?.warning && (
                <span className="terminal-warning model-catalog-note">
                  {modelCatalog.data.warning}
                </span>
              )}
            </div>

            <div className="edit-field">
              <label className="muted">{t("projectEdit.projectArgs")}</label>
              <input
                value={args[tool.key]}
                disabled={disabled}
                placeholder={t("projectEdit.argsPlaceholder")}
                onChange={(event) => updateArgs(tool.key, event.target.value)}
              />
            </div>
          </section>
        );
      })}

      <div className="edit-actions">
        <button className="ghost-button" onClick={() => setView("detail")}>
          {t("common.cancel")}
        </button>
        <button
          className="primary-button"
          disabled={
            saveMutation.isPending || savedArgs.isLoading || !savedArgs.data
          }
          onClick={() => saveMutation.mutate()}
        >
          {t("common.save")}
        </button>
      </div>
      {saveMutation.isError && (
        <p className="error">
          {t("projectEdit.saveFailed", {
            error: String(saveMutation.error),
          })}
        </p>
      )}
    </div>
  );
}

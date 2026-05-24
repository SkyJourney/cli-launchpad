import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { indexByTool, useCliStatus } from "../hooks/useCliStatus";
import { getFlagValue, setFlagValue } from "../lib/args";
import { CLAUDE_MODEL_PRESETS, TOOLS } from "../lib/tools";
import {
  getDirectoryToolArgs,
  listDirectories,
  listTools,
  saveDirectoryToolArgs,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

type ArgsMap = Record<ToolKey, string>;

const EMPTY_ARGS: ArgsMap = { claude: "", codex: "", antigravity: "" };

export function ProjectEditView() {
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);
  const setView = useAppStore((state) => state.setView);
  const queryClient = useQueryClient();

  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const directory =
    directories?.find((d) => d.id === selectedDirectoryId) ?? null;
  const directoryId = directory?.id ?? null;

  const { data: tools } = useQuery({ queryKey: ["tools"], queryFn: listTools });
  const statusByTool = indexByTool(useCliStatus().data);

  const savedArgs = useQuery({
    queryKey: ["directory-tool-args", directoryId],
    queryFn: () => getDirectoryToolArgs(directoryId as number),
    enabled: directoryId != null,
  });

  const [args, setArgs] = useState<ArgsMap>(EMPTY_ARGS);
  const seededFor = useRef<number | null>(null);

  // Seed the editable state once per directory. Guarding on the directory id
  // prevents a background refetch (e.g. on window focus) from overwriting edits.
  useEffect(() => {
    if (
      !savedArgs.data ||
      directoryId == null ||
      seededFor.current === directoryId
    ) {
      return;
    }
    seededFor.current = directoryId;
    const next = { ...EMPTY_ARGS };
    for (const entry of savedArgs.data) {
      next[entry.toolKey] = entry.args;
    }
    setArgs(next);
  }, [savedArgs.data, directoryId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const id = directoryId as number;
      // Skip missing tools: their fields are disabled and unseeded, so writing
      // would wipe any args they already have in the database.
      const editable = TOOLS.filter(
        (tool) => (statusByTool[tool.key]?.status ?? "missing") !== "missing",
      );
      await Promise.all(
        editable.map((tool) =>
          saveDirectoryToolArgs(id, tool.key, args[tool.key].trim()),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["directory-tool-args", directoryId],
      });
      setView("detail");
    },
  });

  if (!directory) {
    return (
      <div className="edit-view">
        <button className="ghost-button" onClick={() => setView("projects")}>
          <ArrowLeft size={15} />
          返回
        </button>
        <p className="muted">未选择目录。</p>
      </div>
    );
  }

  const updateArgs = (toolKey: ToolKey, value: string) =>
    setArgs((prev) => ({ ...prev, [toolKey]: value }));

  const claudeModel = getFlagValue(args.claude, "--model");

  return (
    <div className="edit-view">
      <button className="ghost-button" onClick={() => setView("detail")}>
        <ArrowLeft size={15} />
        返回
      </button>

      <header className="detail-head">
        <h1>编辑参数 · {directory.name}</h1>
        <p className="muted">{directory.path}</p>
      </header>

      {TOOLS.map((tool) => {
        const status = statusByTool[tool.key]?.status ?? "missing";
        const disabled = status === "missing";
        const globalArgs =
          tools?.find((t) => t.key === tool.key)?.globalArgs ?? "";
        return (
          <section
            key={tool.key}
            className={clsx("edit-section", { disabled })}
          >
            <div className="edit-section-head">
              <tool.icon size={18} />
              <strong>{tool.label}</strong>
              {disabled && (
                <span className="muted">未安装，前往设置安装后可编辑</span>
              )}
            </div>

            <div className="edit-field">
              <label className="muted">全局参数（只读，在设置中修改）</label>
              <code className="readonly-args">{globalArgs || "（无）"}</code>
            </div>

            {tool.key === "claude" && (
              <div className="edit-field">
                <label className="muted">模型</label>
                <div className="model-presets">
                  {CLAUDE_MODEL_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      className={clsx("preset-button", {
                        active:
                          (preset.value ?? null) === (claudeModel ?? null),
                      })}
                      disabled={disabled}
                      onClick={() =>
                        updateArgs(
                          "claude",
                          setFlagValue(args.claude, "--model", preset.value),
                        )
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input
                  value={claudeModel ?? ""}
                  disabled={disabled}
                  placeholder="或手动输入模型名（支持第三方模型）"
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    updateArgs(
                      "claude",
                      setFlagValue(
                        args.claude,
                        "--model",
                        value === "" ? null : value,
                      ),
                    );
                  }}
                />
              </div>
            )}

            <div className="edit-field">
              <label className="muted">项目级附加参数</label>
              <input
                value={args[tool.key]}
                disabled={disabled}
                placeholder="例如 --resume 或自定义参数"
                onChange={(event) => updateArgs(tool.key, event.target.value)}
              />
            </div>
          </section>
        );
      })}

      <div className="edit-actions">
        <button className="ghost-button" onClick={() => setView("detail")}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          保存
        </button>
      </div>
      {saveMutation.isError && (
        <p className="error">保存失败：{String(saveMutation.error)}</p>
      )}
    </div>
  );
}

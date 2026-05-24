import { useQuery } from "@tanstack/react-query";
import { Bot, Code2, Rocket } from "lucide-react";
import { useEffect, useState } from "react";
import {
  listDirectories,
  listTools,
  previewLaunch,
  launchTool,
  type ToolKey,
} from "../lib/tauri";
import { useAppStore } from "../store/appStore";

const toolIcons: Record<ToolKey, typeof Bot> = {
  antigravity: Rocket,
  codex: Code2,
  claude: Bot,
};

export function ToolLauncherPanel() {
  const selectedDirectoryId = useAppStore((state) => state.selectedDirectoryId);

  const { data: directories } = useQuery({
    queryKey: ["directories"],
    queryFn: listDirectories,
  });
  const { data: tools } = useQuery({ queryKey: ["tools"], queryFn: listTools });

  const selectedDirectory =
    directories?.find((d) => d.id === selectedDirectoryId) ?? null;

  const [preview, setPreview] = useState<string>("");

  useEffect(() => {
    setPreview("");
  }, [selectedDirectoryId]);

  if (!selectedDirectory) {
    return (
      <div className="launcher-panel">
        <header>
          <p className="eyebrow">未选择目录</p>
          <h1>从左侧选择一个项目目录</h1>
        </header>
      </div>
    );
  }

  const handleLaunch = async (toolKey: ToolKey) => {
    await launchTool(selectedDirectory.id, toolKey);
  };

  const handlePreview = async (toolKey: ToolKey) => {
    const text = await previewLaunch(selectedDirectory.id, toolKey);
    setPreview(text);
  };

  return (
    <div className="launcher-panel">
      <header>
        <p className="eyebrow">Selected directory</p>
        <h1>{selectedDirectory.path}</h1>
      </header>

      <div className="tool-grid">
        {(tools ?? []).map((tool) => {
          const Icon = toolIcons[tool.key];
          return (
            <button
              className="tool-button"
              key={tool.key}
              onClick={() => handleLaunch(tool.key)}
              onMouseEnter={() => handlePreview(tool.key)}
            >
              <Icon size={22} />
              <span>{tool.displayName}</span>
            </button>
          );
        })}
      </div>

      <section className="command-preview">
        <div className="section-heading">Launch preview</div>
        <code>{preview || "悬停工具按钮查看命令预览"}</code>
      </section>
    </div>
  );
}

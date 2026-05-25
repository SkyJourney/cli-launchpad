import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { Terminal } from "lucide-react";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";

export function AboutView() {
  const version = useQuery({ queryKey: qk.appVersion(), queryFn: getVersion });

  return (
    <div className="about-view">
      <header className="detail-head">
        <h1>关于</h1>
      </header>

      <section className="about-card">
        <div className="about-brand">
          <Terminal size={28} />
          <div>
            <strong>CLI Launchpad</strong>
            <span className="muted">版本 {version.data ?? "…"}</span>
          </div>
        </div>

        <p className="muted">
          轻量级桌面启动器：在常用项目目录中一键打开 AI CLI 工作会话，
          管理历史会话、工具参数与版本。
        </p>

        <div className="about-rows">
          <div className="about-row">
            <span className="about-key">技术栈</span>
            <span>Tauri 2 · React · TypeScript · Rust · SQLite</span>
          </div>
          <div className="about-row">
            <span className="about-key">支持的 CLI</span>
            <span className="about-tools">
              {TOOLS.map((tool) => (
                <span className="about-tool" key={tool.key}>
                  <tool.icon size={16} />
                  {tool.label}
                </span>
              ))}
            </span>
          </div>
          <div className="about-row">
            <span className="about-key">命令</span>
            <span>claude · codex · agy</span>
          </div>
        </div>
      </section>
    </div>
  );
}

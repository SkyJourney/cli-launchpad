import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import appLicense from "../../LICENSE?raw";
import ibmPlexLicense from "../assets/fonts/ibm-plex-sans-sc/LICENSE.txt?raw";
import mapleLicense from "../assets/fonts/maple/LICENSE.txt?raw";
import { AppLogo } from "../components/AppLogo";
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
          <AppLogo size={48} />
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
        </div>
      </section>

      <section className="about-card about-license-card">
        <div>
          <span className="about-key">开源许可</span>
          <p className="muted about-license-intro">
            CLI Launchpad 使用 MIT License；内置字体继续遵循各自的 SIL Open Font
            License 1.1。
          </p>
        </div>

        <div className="about-license-list">
          <LicenseDetails
            title="CLI Launchpad · MIT License"
            text={appLicense}
          />
          <LicenseDetails
            title="IBM Plex Sans SC · SIL OFL 1.1"
            text={ibmPlexLicense}
          />
          <LicenseDetails
            title="Maple Mono NF CN · SIL OFL 1.1"
            text={mapleLicense}
          />
        </div>
      </section>
    </div>
  );
}

function LicenseDetails({ title, text }: { title: string; text: string }) {
  return (
    <details className="license-details">
      <summary>{title}</summary>
      <pre>{text}</pre>
    </details>
  );
}

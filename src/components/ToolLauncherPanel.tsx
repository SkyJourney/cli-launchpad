import { Bot, Code2, Rocket } from "lucide-react";

const tools = [
  { key: "antigravity", label: "Antigravity", icon: Rocket },
  { key: "codex", label: "Codex", icon: Code2 },
  { key: "claude", label: "Claude Code", icon: Bot }
];

export function ToolLauncherPanel() {
  return (
    <div className="launcher-panel">
      <header>
        <p className="eyebrow">Selected directory</p>
        <h1>C:\Projects\cli-launchpad</h1>
      </header>

      <div className="tool-grid">
        {tools.map((tool) => {
          const Icon = tool.icon;
          return (
            <button className="tool-button" key={tool.key}>
              <Icon size={22} />
              <span>{tool.label}</span>
            </button>
          );
        })}
      </div>

      <section className="command-preview">
        <div className="section-heading">Launch preview</div>
        <code>
          wt.exe new-tab -d "C:\Projects\cli-launchpad" pwsh.exe -NoLogo
          -NoExit -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();
          Set-Location -LiteralPath 'C:\Projects\cli-launchpad'; & codex"
        </code>
      </section>
    </div>
  );
}


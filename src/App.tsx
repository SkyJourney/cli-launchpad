import { Terminal } from "lucide-react";
import { DirectoryList } from "./components/DirectoryList";
import { ToolLauncherPanel } from "./components/ToolLauncherPanel";

export function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Terminal size={20} />
          <span>CLI Launchpad</span>
        </div>
        <DirectoryList />
      </aside>
      <section className="workspace">
        <ToolLauncherPanel />
      </section>
    </main>
  );
}


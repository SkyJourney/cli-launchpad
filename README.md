# CLI Launchpad

CLI Launchpad is a lightweight desktop launcher for opening frequently used project directories with Antigravity CLI, Codex CLI, or Claude Code CLI.

The project follows a Tauri-style architecture inspired by CC-Switch:

- React + TypeScript for the desktop UI.
- Rust/Tauri commands for filesystem, SQLite, and process launching.
- SQLite as the single source of truth for directories, tools, shell profiles, and per-directory arguments.
- Device-local UI preferences can later live in JSON/Tauri store.

## Goals

- Cache frequently used directories in SQLite.
- Launch a configured CLI in the selected directory with one click.
- Keep shell parameters, global CLI parameters, and directory-specific CLI parameters decoupled.
- Prefer a small desktop footprint over Electron-style packaging.
- Make the final command previewable before launching.

## Planned Stack

- Tauri 2
- React
- TypeScript
- Vite
- Rust
- rusqlite
- Windows Terminal / PowerShell integration

The current repository is a deliberate skeleton. Dependencies are declared, but not installed.

## First Run

After installing Node.js, Rust, and the Tauri prerequisites:

```powershell
npm install
npm run tauri dev
```

## Project Layout

```text
docs/                         Product and architecture notes
src/                          React UI
src-tauri/                    Tauri/Rust backend
src-tauri/migrations/         SQLite migrations
src-tauri/src/commands/       IPC commands exposed to the UI
src-tauri/src/services/       Business logic
src-tauri/src/db/             DB connection and repositories
src-tauri/src/platform/       OS-specific launch helpers
```

## MVP Scope

- Directory CRUD.
- Tool configuration for Antigravity, Codex, and Claude Code.
- Shell profile configuration.
- Command preview.
- One-click launch into a terminal session.


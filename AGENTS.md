# Agent Notes

## Working Principles

- Keep this app lightweight. Do not introduce Electron or a server runtime.
- Prefer the existing Tauri + React + Rust structure.
- Keep user data in SQLite unless it is clearly device-only UI state.
- Keep launch logic in Rust services, not React components.
- Avoid ad hoc command string concatenation. Build argument lists and quote only at the shell boundary.

## Architecture

- `src/` owns presentation state and calls Tauri commands.
- `src-tauri/src/commands/` exposes small IPC entry points.
- `src-tauri/src/services/` owns behavior such as command composition and validation.
- `src-tauri/src/db/` owns SQLite schema, connection, and repositories.
- `src-tauri/src/platform/` owns OS-specific command launch details.

## Safety Rules

- Treat configured directories as user-controlled input.
- Use PowerShell `Set-Location -LiteralPath` for Windows paths.
- Preview launch commands in the UI before executing.
- Do not store secrets in SQLite. Use OS credential storage if secrets become necessary.
- Never add destructive git or filesystem behavior without explicit user request.

## Development

```powershell
npm install
npm run tauri dev
```

Run formatting before larger commits:

```powershell
npm run format
cargo fmt --manifest-path src-tauri/Cargo.toml
```


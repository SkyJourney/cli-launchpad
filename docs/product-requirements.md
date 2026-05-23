# Product Requirements

## Problem

Opening Antigravity CLI, Codex CLI, or Claude Code CLI for a specific project currently requires repeatedly switching directories in PowerShell and typing the desired CLI command.

## Target User

A developer who works across several local repositories and uses multiple agentic CLI tools.

## MVP

- Persist frequently used directories.
- Configure three default tools: Antigravity CLI, Codex CLI, Claude Code CLI.
- Configure shell launch behavior separately from tool arguments.
- Configure global tool arguments separately from directory-specific arguments.
- Show a command preview.
- Launch the selected tool in the selected directory.

## Non-Goals

- No Electron.
- No remote backend.
- No account management in the first version.
- No proxy or model routing logic in the first version.

## Data Ownership

SQLite is the source of truth for functional configuration:

- directories
- tools
- shell profiles
- per-directory tool arguments
- launch history

JSON/Tauri store can be used later for local UI preferences:

- window bounds
- active theme
- last selected directory


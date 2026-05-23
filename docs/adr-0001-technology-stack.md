# ADR 0001: Technology Stack

## Status

Accepted

## Context

The application needs to be a lightweight desktop tool for launching local CLI agents in project directories. Electron is intentionally excluded because package size and runtime overhead are not aligned with the product goal.

CC-Switch is a useful reference because it combines React/TypeScript UI with a Tauri/Rust backend, SQLite state, and native desktop behavior.

## Decision

Use:

- Tauri 2 for the desktop shell.
- React and TypeScript for UI.
- Rust for native commands, launch orchestration, SQLite access, and platform-specific behavior.
- SQLite as the durable configuration store.

## Consequences

- The UI can be built quickly with familiar web tooling.
- Native launch behavior stays in Rust, away from renderer code.
- The app remains materially lighter than an Electron equivalent.
- Contributors need both Node.js and Rust toolchains.


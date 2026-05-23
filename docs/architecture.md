# Architecture

The application follows the same broad design thinking as CC-Switch: a fast web UI on top of a native backend, with state and side effects kept out of the renderer.

## Layers

```text
React UI
  calls Tauri commands

Commands
  validate IPC boundaries and map request/response types

Services
  implement directory management, command composition, validation, and launch flow

DB repositories
  own SQLite queries and migrations

Platform helpers
  own Windows Terminal, PowerShell, and future macOS/Linux launch behavior
```

## Launch Composition

Launch input is assembled in this order:

```text
shell profile
+ shell init script
+ selected directory
+ tool executable
+ tool global args
+ directory-specific tool args
```

For Windows, the first implementation should prefer:

```powershell
wt.exe new-tab -d "<directory>" pwsh.exe -NoLogo -NoExit -Command "<script>"
```

The PowerShell script should use:

```powershell
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$OutputEncoding=[System.Text.UTF8Encoding]::new()
Set-Location -LiteralPath '<directory>'
& <tool> <args>
```

## Safety

- Directory paths must be validated before launch.
- PowerShell paths should use `-LiteralPath`.
- Tool executable and arguments should be modeled separately.
- String quoting should be isolated to `platform/powershell.rs`.


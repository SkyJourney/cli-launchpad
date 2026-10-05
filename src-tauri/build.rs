use std::{fs, path::PathBuf};

fn main() {
    let manifest_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts/app-commands.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest =
        fs::read_to_string(&manifest_path).expect("failed to read contracts/app-commands.json");
    let commands: Vec<String> =
        serde_json::from_str(&manifest).expect("invalid contracts/app-commands.json");
    let commands: Vec<&'static str> = commands
        .into_iter()
        .map(|command| Box::leak(command.into_boxed_str()) as &'static str)
        .collect();
    let command_names: &'static [&'static str] = Box::leak(commands.into_boxed_slice());

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(command_names)),
    )
    .expect("failed to configure Tauri command permissions");
}

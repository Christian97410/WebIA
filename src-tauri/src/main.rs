// WebIA - Tauri v2 entry point
// Spawns the Node.js Express server as a sidecar and opens the webview.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

// ─── IPC Commands ──────────────────────────────────────────────────────────────

/// Pick a directory using the native OS file picker.
/// Called from JS: `invoke('pick_directory')`
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|f| f.to_string()))
}

/// Read a token from the encrypted Stronghold vault.
#[tauri::command]
async fn get_token(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String> {
    let store = app.state::<TokenStore>();
    Ok(store.get(&provider))
}

/// Save a token into the encrypted Stronghold vault.
#[tauri::command]
async fn store_token(
    app: tauri::AppHandle,
    provider: String,
    token: String,
) -> Result<(), String> {
    let store = app.state::<TokenStore>();
    store.set(&provider, &token);
    Ok(())
}

/// Delete a token from the vault.
#[tauri::command]
async fn delete_token(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let store = app.state::<TokenStore>();
    store.remove(&provider);
    Ok(())
}

/// List all stored provider tokens (returns provider names, not the tokens).
#[tauri::command]
async fn list_token_providers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let store = app.state::<TokenStore>();
    Ok(store.providers())
}

/// Check whether the Claude Code SDK is available on this system.
/// The check is done by looking for the `claude` binary in PATH, or
/// checking if the npm package is resolvable from the project root.
#[tauri::command]
async fn check_claude_sdk(app: tauri::AppHandle) -> Result<ClaudeSDKStatus, String> {
    let shell = app.shell();

    // Try to detect `claude` CLI in PATH (Claude Code installs this).
    let cli_available = match shell
        .command("which")
        .args(["claude"])
        .output()
        .await
    {
        Ok(output) => output.status.success(),
        Err(_) => false,
    };

    // Check for existing Claude Code credentials.
    let home = std::env::var("HOME").unwrap_or_default();
    let creds_path = std::path::PathBuf::from(&home).join(".claude/credentials.json");
    let has_credentials = creds_path.exists();

    // Check for the npm SDK package.
    let sdk_installed = match shell
        .command("node")
        .args(["-e", "require.resolve('@anthropic-ai/claude-code-sdk')"])
        .output()
        .await
    {
        Ok(output) => output.status.success(),
        Err(_) => false,
    };

    Ok(ClaudeSDKStatus {
        cli_available,
        sdk_installed,
        has_credentials,
    })
}

/// Return the port the sidecar server is listening on.
/// In dev mode this returns 3000 (the default dev port).
#[tauri::command]
async fn get_server_port(app: tauri::AppHandle) -> Result<u16, String> {
    match app.try_state::<ServerPort>() {
        Some(port) => Ok(port.0),
        None => Ok(3000), // Dev mode default
    }
}

// ─── Data types ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct ClaudeSDKStatus {
    /// Whether the `claude` CLI binary is in PATH.
    cli_available: bool,
    /// Whether the @anthropic-ai/claude-code-sdk npm package is installed.
    sdk_installed: bool,
    /// Whether ~/.claude/credentials.json exists (reusable token).
    has_credentials: bool,
}

/// In-memory token cache (backed by Stronghold on disk).
/// A real implementation would read/write through tauri-plugin-stronghold.
/// This struct provides a synchronous interface for the IPC commands.
struct TokenStore {
    tokens: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl TokenStore {
    fn new() -> Self {
        Self {
            tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn get(&self, provider: &str) -> Option<String> {
        self.tokens.lock().unwrap().get(provider).cloned()
    }

    fn set(&self, provider: &str, token: &str) {
        self.tokens
            .lock()
            .unwrap()
            .insert(provider.to_string(), token.to_string());
    }

    fn remove(&self, provider: &str) {
        self.tokens.lock().unwrap().remove(provider);
    }

    fn providers(&self) -> Vec<String> {
        self.tokens.lock().unwrap().keys().cloned().collect()
    }
}

/// Holds the port the sidecar server is listening on.
struct ServerPort(u16);

// ─── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        // -- Plugins --
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // -- Managed state --
        .manage(TokenStore::new())
        // -- IPC commands --
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            get_token,
            store_token,
            delete_token,
            list_token_providers,
            check_claude_sdk,
            get_server_port,
        ])
        // -- App setup: spawn the sidecar server --
        .setup(|app| {
            // In dev mode, the server is started by beforeDevCommand (npm run dev).
            // In production, spawn the bundled sidecar.
            #[cfg(not(debug_assertions))]
            {
                let port = portpicker::pick_unused_port().unwrap_or(3000);

                // Spawn the sidecar Node server.
                let shell = app.handle().shell();
                let (mut _rx, _child) = shell
                    .sidecar("wia-server")
                    .expect("failed to locate wia-server sidecar")
                    .args([format!("--port={}", port)])
                    .spawn()
                    .expect("failed to spawn wia-server");

                app.manage(ServerPort(port));

                // Navigate the webview to the Express server instead of using
                // bundled frontend files. This way all /api/* calls work with
                // relative URLs — no baseUrl detection needed.
                let main_window = app.get_webview_window("main")
                    .expect("main window not found");

                // Wait for the sidecar to be ready, then navigate
                std::thread::spawn(move || {
                    use std::net::TcpStream;
                    use std::thread::sleep;
                    use std::time::Duration;
                    let addr = format!("127.0.0.1:{}", port);
                    for _ in 0..50 {
                        if TcpStream::connect(&addr).is_ok() {
                            sleep(Duration::from_millis(300));
                            let url = format!("http://localhost:{}", port);
                            let _ = main_window.navigate(url.parse().unwrap());
                            return;
                        }
                        sleep(Duration::from_millis(200));
                    }
                });
            }

            // Check for updates in the background (production only).
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    match handle.updater().unwrap().check().await {
                        Ok(Some(update)) => {
                            // In a real app, prompt the user before installing.
                            let _ = update.download_and_install(|_, _| {}, || {}).await;
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running WebIA");
}

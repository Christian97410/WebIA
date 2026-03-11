# WebIA Phase 2 -- Tauri Desktop App

## Overview

Phase 2 wraps the existing WebIA (Express + browser) into a native desktop app using Tauri v2. The frontend code (`src/client/`) stays exactly the same. The Express server becomes a sidecar managed by the Tauri process. The result is a single `.dmg` / `.msi` / `.AppImage` that the user installs like any other app.

---

## 1. Tauri Setup

### 1.1 Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable (1.77+) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | 20+ | already in Phase 1 |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2"` |
| macOS | Xcode Command Line Tools | `xcode-select --install` |
| Windows | Visual Studio C++ Build Tools + WebView2 | see tauri.app docs |
| Linux | `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev` | apt/dnf |

### 1.2 Project Structure After Phase 2

```
WebIA/
  bin/wia.js               # CLI entrypoint (kept for dev / CI)
  package.json             # adds @tauri-apps/cli, @tauri-apps/api
  src/
    client/                # UNCHANGED -- served by Tauri webview
      index.html
      app.js
      views/
      styles/
      utils/
      components/
    server/                # UNCHANGED -- runs as sidecar
      index.js
      routes/
      ws.js
  src-tauri/
    tauri.conf.json        # Tauri config
    Cargo.toml             # Rust crate
    build.rs               # needed for Tauri build step
    icons/                 # app icons (1024x1024 PNG -> `cargo tauri icon`)
    src/
      main.rs              # Rust entry: spawn server, open webview, IPC commands
```

### 1.3 Key Config Decisions

- **Dev mode**: `cargo tauri dev` starts the Node server via `beforeDevCommand`, then opens the webview pointing at `http://localhost:3000`.
- **Production build**: the Node server is bundled as an **embedded sidecar** (`externalBin` in tauri.conf.json) compiled with `pkg` or `sea` (Node single-executable). The webview loads the static client files from disk (no HTTP for the frontend).
- **IPC bridge**: Tauri commands (Rust -> JS, JS -> Rust) are used only for native features: file picker, keychain, auto-update. All existing HTTP/WS APIs stay untouched.

---

## 2. Migration Steps

### Step 1 -- Install Tauri tooling

```bash
cd WebIA
npm install -D @tauri-apps/cli@^2
npm install @tauri-apps/api@^2
npm install @anthropic-ai/sdk openai   # for OAuth later
```

### Step 2 -- Create src-tauri skeleton

The three files created alongside this doc (`tauri.conf.json`, `Cargo.toml`, `src/main.rs`) form the skeleton. Then:

```bash
cd src-tauri
cargo check          # verify Rust compiles
cd ..
npx tauri icon src-tauri/icons/app-icon.png   # generate all icon sizes
```

### Step 3 -- Wire dev workflow

Add to `package.json`:

```json
"scripts": {
  "dev": "node src/server/index.js",
  "tauri": "tauri",
  "tauri:dev": "cargo tauri dev",
  "tauri:build": "cargo tauri build"
}
```

`cargo tauri dev` will:
1. Run `npm run dev` (the `beforeDevCommand` in tauri.conf.json)
2. Wait for `http://localhost:3000` to be ready
3. Open the Tauri webview pointing at that URL

### Step 4 -- Bundle the server as a sidecar

For production, the Node server must run without a global Node install:

1. Use Node's built-in **Single Executable Application** (SEA) feature (Node 21+):
   ```bash
   node --experimental-sea-config sea-config.json
   ```
   This produces a standalone `wia-server` binary.

2. Declare it in `tauri.conf.json` under `bundle.externalBin`:
   ```json
   "externalBin": ["binaries/wia-server"]
   ```

3. In `main.rs`, spawn this binary with `tauri::api::process::Command::new_sidecar("wia-server")`.

4. The webview loads `index.html` from the bundled `src/client/` directory for the UI, and connects to `localhost:<port>` for the API/WS.

### Step 5 -- Verify everything works

```bash
cargo tauri dev     # dev mode, hot reload still works
cargo tauri build   # produces .dmg / .msi / .AppImage
```

---

## 3. Native File Picker

### What changes

The Phase 1 `browse()` method in `src/client/views/projects.js` is a no-op -- the user types a path. In Phase 2, it opens a native OS directory picker.

### Implementation

**Rust side** (`main.rs`):

```rust
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|f| f.to_string()))
}
```

**JS side** (minimal change in `projects.js`):

```js
browse(input) {
  if (window.__TAURI__) {
    // Phase 2: native picker
    const { invoke } = window.__TAURI__.core;
    invoke('pick_directory').then(path => {
      if (path) {
        input.value = path;
        this.onOpen(path);
      }
    });
  } else {
    // Phase 1 fallback: manual input
    input.focus();
    input.placeholder = 'Type or paste a directory path...';
  }
}
```

This is the only change to `src/client/` code. It is backward-compatible: if `window.__TAURI__` does not exist (browser mode), the old behavior is preserved.

**Dependency**: add `tauri-plugin-dialog` in `Cargo.toml` and register it in `main.rs`.

---

## 4. OAuth Flow (Anthropic + OpenAI)

### Goal

The user signs in with their Anthropic and/or OpenAI account directly from the app. No manual API key entry. Tokens are stored in the OS keychain.

### 4.1 OAuth Architecture

```
User clicks "Sign in with Anthropic"
  -> Tauri opens system browser to authorization URL
  -> User authenticates on anthropic.com / openai.com
  -> Provider redirects to http://localhost:<random-port>/callback
  -> Tauri's built-in HTTP listener catches the redirect
  -> Exchange code for access_token + refresh_token
  -> Store tokens in OS keychain via tauri-plugin-store + keyring
  -> Close the browser tab, show "Connected" in the app
```

### 4.2 Anthropic OAuth

Anthropic exposes an OAuth flow for third-party apps (same flow Claude Code uses):

1. **Authorization URL**: `https://console.anthropic.com/oauth/authorize`
   - `client_id` = registered WebIA app ID
   - `redirect_uri` = `http://localhost:{port}/callback`
   - `scope` = `messages:write`
   - `response_type` = `code`
   - PKCE: generate `code_verifier` + `code_challenge` (S256)

2. **Token exchange**: POST `https://console.anthropic.com/oauth/token` with the auth code.

3. **Reuse existing Claude Code token**: check `~/.claude/credentials.json` first. If valid, skip OAuth. Only prompt sign-in if no existing token or it is expired.

### 4.3 OpenAI OAuth

Same pattern for OpenAI (Codex integration):

1. **Authorization URL**: `https://auth.openai.com/authorize`
   - `client_id`, `redirect_uri`, `scope`, PKCE

2. **Token exchange**: POST `https://auth.openai.com/token`

### 4.4 Secure Token Storage

Use `tauri-plugin-stronghold` (encrypted vault backed by OS keychain):

```rust
#[tauri::command]
async fn store_token(
    app: tauri::AppHandle,
    provider: String,   // "anthropic" or "openai"
    token: String,
) -> Result<(), String> {
    use tauri_plugin_stronghold::StrongholdExt;
    let stronghold = app.stronghold();
    stronghold.save_secret(&provider, token.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_token(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_stronghold::StrongholdExt;
    let stronghold = app.stronghold();
    match stronghold.get_secret(&provider) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        Err(_) => Ok(None),
    }
}
```

The server reads the token at startup and passes it to the Anthropic/OpenAI SDK in `routes/ai.js`.

### 4.5 Token Refresh

Both providers issue refresh tokens. The server checks expiry before each API call and refreshes automatically. If refresh fails, the app shows "Session expired -- sign in again."

---

## 5. Auto-Update Mechanism

Use `tauri-plugin-updater` (built into Tauri v2).

### 5.1 Server Side

Host an `update.json` file on a static server (GitHub Releases, S3, or Cloudflare R2):

```json
{
  "version": "0.2.1",
  "notes": "Bug fixes and performance improvements",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://releases.wia.dev/v0.2.1/WebIA_0.2.1_aarch64.app.tar.gz",
      "signature": "..."
    },
    "darwin-x86_64": { "url": "...", "signature": "..." },
    "windows-x86_64": { "url": "...", "signature": "..." },
    "linux-x86_64": { "url": "...", "signature": "..." }
  }
}
```

### 5.2 Client Side

In `main.rs`:

```rust
use tauri_plugin_updater::UpdaterExt;

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(Some(update)) = handle.updater().check().await {
            // Prompt user, then:
            update.download_and_install(|_, _| {}, || {}).await.ok();
        }
    });
    Ok(())
}
```

### 5.3 Config

In `tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://releases.wia.dev/update.json"],
    "pubkey": "<your-ed25519-public-key>"
  }
}
```

Generate the key pair with `cargo tauri signer generate -w ~/.tauri/wia.key`.

---

## 6. Building for macOS, Windows, Linux

### 6.1 Build Commands

```bash
# macOS (universal binary: ARM + Intel)
cargo tauri build --target universal-apple-darwin

# Windows (from Windows machine or cross-compile)
cargo tauri build

# Linux
cargo tauri build --bundles deb appimage
```

### 6.2 CI/CD with GitHub Actions

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: universal-apple-darwin
            args: --target universal-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            args: ""
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            args: --bundles deb appimage
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npx tauri build ${{ matrix.args }}
      - uses: softprops/action-gh-release@v2
        with:
          files: src-tauri/target/release/bundle/**/*
```

### 6.3 Output Artifacts

| Platform | Format | Location |
|----------|--------|----------|
| macOS | `.dmg`, `.app` | `src-tauri/target/release/bundle/dmg/` |
| Windows | `.msi`, `.nsis` (exe installer) | `src-tauri/target/release/bundle/msi/` |
| Linux | `.deb`, `.AppImage` | `src-tauri/target/release/bundle/deb/`, `bundle/appimage/` |

---

## 7. App Signing and Distribution

### 7.1 macOS

1. **Apple Developer account** ($99/year).
2. **Code signing**: set env vars before build:
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_CERTIFICATE="base64-encoded .p12"
   export APPLE_CERTIFICATE_PASSWORD="..."
   ```
   Tauri signs automatically when these are present.

3. **Notarization**: set additionally:
   ```bash
   export APPLE_API_ISSUER="..."
   export APPLE_API_KEY="..."
   export APPLE_API_KEY_PATH="AuthKey_XXX.p8"
   ```
   Tauri v2 notarizes as part of `cargo tauri build`.

4. **Distribution**: upload `.dmg` to GitHub Releases. Users download and drag to Applications. Gatekeeper passes because the app is signed + notarized.

### 7.2 Windows

1. **Code signing certificate** (EV or OV from a CA like DigiCert, Sectigo).
2. Set env var:
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
   ```
   Or use `signtool` in CI.
3. **Distribution**: `.msi` or `.exe` installer via GitHub Releases.

### 7.3 Linux

No signing required. Distribute `.AppImage` (universal) and `.deb` (Debian/Ubuntu).

---

## 8. What Stays the Same vs What Changes

### Stays the same (no changes)

| Component | Notes |
|-----------|-------|
| `src/client/` (all frontend code) | Loaded by Tauri webview instead of browser, but identical code |
| `src/server/index.js` | Express server, same routes, same WebSocket |
| `src/server/routes/*` | All API routes unchanged |
| `src/server/ws.js` | WebSocket for live reload |
| `src/server/source-map.js` | CSS/HTML source mapping |
| `package.json` dependencies (core) | express, ws, parse5, postcss, chokidar, simple-git |
| HTTP + WebSocket protocol | Frontend still talks to `localhost:PORT` |
| `bin/wia.js` | CLI entrypoint preserved for dev and non-desktop usage |

### Changes (new or modified)

| Component | What | Why |
|-----------|------|-----|
| `src-tauri/` (new) | Rust crate + config | Tauri shell |
| `src/client/views/projects.js` | `browse()` method | Call native file picker via `window.__TAURI__` |
| `package.json` scripts | Add `tauri:dev`, `tauri:build` | Dev/build commands |
| `package.json` devDependencies | Add `@tauri-apps/cli` | Tauri CLI |
| `package.json` dependencies | Add `@tauri-apps/api` | JS bridge to Tauri |
| Server startup | Spawned by Tauri in prod, standalone in dev | Lifecycle management |
| Auth | OAuth + keychain (new) | Replace manual API key entry |
| Distribution | `.dmg` / `.msi` / `.AppImage` | Native installer instead of `npm install -g` |

### Things explicitly NOT changed

- No migration to a JS framework (React, Vue, Svelte). The vanilla JS frontend stays vanilla.
- No switch from Express to a Rust web server. Express remains the backend.
- No changes to how CSS/HTML parsing works (postcss, parse5).
- No changes to the AI integration protocol -- only how auth tokens are obtained.

# WebIA Sidecar — Node.js Server Bundle

## Overview

In production (Tauri desktop builds), the Node.js Express server is bundled as
a standalone binary called `wia-server`. Tauri spawns this binary as a
**sidecar** process when the app starts, and terminates it when the app closes.

## How it works

1. **Build the sidecar** using Node.js Single Executable Application (SEA):
   ```bash
   node --experimental-sea-config sea-config.json
   cp $(command -v node) binaries/wia-server
   npx postject binaries/wia-server NODE_SEA_BLOB sea-prep.blob \
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
   ```

2. **Declare it in `tauri.conf.json`** under `bundle.externalBin`:
   ```json
   "externalBin": ["binaries/wia-server"]
   ```
   Tauri expects platform-specific binaries following the naming convention:
   - `binaries/wia-server-aarch64-apple-darwin` (macOS ARM)
   - `binaries/wia-server-x86_64-apple-darwin` (macOS Intel)
   - `binaries/wia-server-x86_64-pc-windows-msvc.exe` (Windows)
   - `binaries/wia-server-x86_64-unknown-linux-gnu` (Linux)

3. **Tauri spawns it** in `main.rs` via `tauri_plugin_shell`:
   ```rust
   let (mut rx, child) = shell
       .sidecar("wia-server")
       .args(["--port=PORT"])
       .spawn()
       .expect("failed to spawn wia-server");
   ```

4. **Port selection**: Tauri picks an unused port with `portpicker` and passes
   it as `--port=PORT`. The frontend reads this port via the `get_server_port`
   IPC command.

## Dev mode

During development (`cargo tauri dev`), the sidecar is NOT used. Instead,
`beforeDevCommand` in `tauri.conf.json` runs `npm run dev`, which starts the
Express server directly via Node.js on port 3000.

## Directory structure

```
src-tauri/
  sidecar/
    README.md          <- this file
  binaries/            <- platform-specific sidecar binaries (gitignored)
    wia-server-*
```

## SEA config

Create `sea-config.json` at the project root:

```json
{
  "main": "src/server/index.js",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
```

Then run:
```bash
node --experimental-sea-config sea-config.json
```

This generates `sea-prep.blob`, which is injected into a copy of the Node
binary to produce the standalone `wia-server` executable.

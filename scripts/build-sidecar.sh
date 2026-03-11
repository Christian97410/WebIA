#!/usr/bin/env bash
# build-sidecar.sh
# Builds the WebIA Node.js server into a standalone executable using
# Node.js Single Executable Application (SEA) support, then places
# the binary into src-tauri/sidecar/ with the correct target triple suffix
# so Tauri can bundle it as an external binary.
#
# Steps:
#   1. Bundle ESM server into a single CJS file via esbuild
#   2. Generate SEA blob from the bundled file
#   3. Copy Node binary and inject the blob
#   4. Place in src-tauri/sidecar/ with target triple suffix
#
# Usage:
#   ./scripts/build-sidecar.sh              # auto-detect current platform
#   ./scripts/build-sidecar.sh <target>     # explicit target triple

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$PROJECT_ROOT/src-tauri/sidecar"
SERVER_ENTRY="$PROJECT_ROOT/src/server/index.js"
BUILD_DIR="$SCRIPT_DIR/.sea-build"

# ── Detect or accept target triple ──────────────────────────────────────────

detect_target() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Darwin)
            case "$arch" in
                arm64)  echo "aarch64-apple-darwin" ;;
                x86_64) echo "x86_64-apple-darwin" ;;
                *)      echo "unsupported-$arch-darwin"; return 1 ;;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64)  echo "x86_64-unknown-linux-gnu" ;;
                aarch64) echo "aarch64-unknown-linux-gnu" ;;
                *)       echo "unsupported-$arch-linux"; return 1 ;;
            esac
            ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            echo "x86_64-pc-windows-msvc"
            ;;
        *)
            echo "unsupported-$os-$arch"; return 1
            ;;
    esac
}

TARGET="${1:-$(detect_target)}"

# Determine output binary name (Windows gets .exe suffix)
case "$TARGET" in
    *windows*)
        BINARY_NAME="wia-server-${TARGET}.exe"
        NODE_COPY="node-sea.exe"
        ;;
    *)
        BINARY_NAME="wia-server-${TARGET}"
        NODE_COPY="node-sea"
        ;;
esac

OUTPUT_PATH="$SIDECAR_DIR/$BINARY_NAME"

echo "============================================"
echo " WebIA Sidecar Builder"
echo "============================================"
echo " Target:  $TARGET"
echo " Entry:   $SERVER_ENTRY"
echo " Output:  $OUTPUT_PATH"
echo "============================================"

# ── Preflight checks ───────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js is not installed or not in PATH."
    exit 1
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "ERROR: Node.js >= 20 is required for SEA support (found $NODE_VERSION)."
    exit 1
fi

if [ ! -f "$SERVER_ENTRY" ]; then
    echo "ERROR: Server entry point not found at $SERVER_ENTRY"
    exit 1
fi

# ── Clean build directory ──────────────────────────────────────────────────

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$SIDECAR_DIR"

# ── Step 1: Bundle the ESM server into a single CJS file ─────────────────
# Node SEA doesn't support ESM imports, so we bundle everything into one file.

BUNDLED_SERVER="$BUILD_DIR/server-bundle.cjs"

echo "[1/5] Bundling server with esbuild..."
npx esbuild "$SERVER_ENTRY" \
    --bundle \
    --platform=node \
    --target=node20 \
    --format=cjs \
    --outfile="$BUNDLED_SERVER" \
    --external:@anthropic-ai/claude-code-sdk \
    --external:fsevents

echo "  Bundled to $(du -k "$BUNDLED_SERVER" | cut -f1) KB"

# ── Step 2: Create the SEA configuration ───────────────────────────────────

SEA_CONFIG="$BUILD_DIR/sea-config.json"
SEA_BLOB="$BUILD_DIR/sea-prep.blob"

cat > "$SEA_CONFIG" <<SEAEOF
{
  "main": "$BUNDLED_SERVER",
  "output": "$SEA_BLOB",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
SEAEOF

echo "[2/5] Generating SEA blob..."
node --experimental-sea-config "$SEA_CONFIG"

# ── Step 3: Copy the Node binary ──────────────────────────────────────────

NODE_PATH="$(command -v node)"
NODE_COPY_PATH="$BUILD_DIR/$NODE_COPY"

echo "[3/5] Copying Node binary..."
cp "$NODE_PATH" "$NODE_COPY_PATH"

# ── Step 4: Inject the SEA blob into the copied binary ────────────────────

echo "[4/5] Injecting SEA blob..."

case "$(uname -s)" in
    Darwin)
        # Remove the existing code signature first (macOS requires this)
        codesign --remove-signature "$NODE_COPY_PATH" 2>/dev/null || true

        npx --yes postject "$NODE_COPY_PATH" NODE_SEA_BLOB "$SEA_BLOB" \
            --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
            --macho-segment-name NODE_SEA

        # Re-sign with ad-hoc signature
        codesign --sign - "$NODE_COPY_PATH"
        ;;
    Linux)
        npx --yes postject "$NODE_COPY_PATH" NODE_SEA_BLOB "$SEA_BLOB" \
            --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
        ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
        npx --yes postject "$NODE_COPY_PATH" NODE_SEA_BLOB "$SEA_BLOB" \
            --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
        if command -v signtool &>/dev/null; then
            echo "  (Signing with signtool...)"
            signtool sign /fd SHA256 "$NODE_COPY_PATH" 2>/dev/null || true
        fi
        ;;
esac

# ── Step 5: Move to sidecar directory ─────────────────────────────────────

echo "[5/5] Installing sidecar binary..."
mv "$NODE_COPY_PATH" "$OUTPUT_PATH"
chmod +x "$OUTPUT_PATH"

# ── Cleanup ───────────────────────────────────────────────────────────────

rm -rf "$BUILD_DIR"

SIZE_MB="$(du -m "$OUTPUT_PATH" | cut -f1)"

echo ""
echo "============================================"
echo " Sidecar built successfully!"
echo " Binary: $OUTPUT_PATH"
echo " Size:   ${SIZE_MB} MB"
echo "============================================"

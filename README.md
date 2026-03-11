# wia

Visual editor for local web projects with AI integration.

## Install

```
npm install -g wia
```

Or run without installing:

```
npx wia ./my-project
```

## Usage

```
wia /path/to/project [--port 3000]
```

Open the printed URL in your browser to start editing.

## Features

- Live visual editing of HTML, CSS, and assets in the browser
- File watching with instant preview updates via WebSocket
- AI-powered code modifications through the Claude Code SDK (optional)
- Git integration for diffing and version control
- PostCSS processing for stylesheets
- Works with any static or server-rendered web project

## Options

| Flag | Description |
|------|-------------|
| `--port <n>` | Port to listen on (default: 3000, or `PORT` env) |
| `--version, -v` | Print version |
| `--help, -h` | Show usage help |

## License

MIT

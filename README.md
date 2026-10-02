# Context Drop

One plugin for **Claude Code** and **Codex** that opens a local browser page bound to the chat you opened it from. Drop or paste screenshots, selected text, links, text/code files, and text-based PDFs, then press **Send to <chat>** to deliver them into that same chat.

- No account, no API key, no cloud service. Everything stays in `~/.context-drop` until the agent reads it.
- One shared local service; each chat gets its own destination, draft, and delivery history.
- Runtime prerequisite: **Node.js 22.18+** on PATH (the TypeScript source runs directly, so there's no build step and no dependencies).

## Install

From a clone of this repository:

**Claude Code**

```bash
claude plugin marketplace add /path/to/context-drop
claude plugin install context-drop@context-drop-local
# Start sessions with the channel enabled so sends are pushed into the chat:
claude --dangerously-load-development-channels plugin:context-drop@context-drop-local
```

Channels are a Claude Code research preview. Until Context Drop is on an approved channel allowlist (or your org's `allowedChannelPlugins`), the development flag is required. Without it, the tools still work, but sends wait until you ask the agent to check (`list_drops`).

**Codex**

```bash
codex plugin marketplace add /path/to/context-drop
codex plugin add context-drop@context-drop-local
```

Codex asks for approval the first time the agent calls a Context Drop tool. Choose "always allow" for this server if you don't want to be asked each time.

## Use

In a chat, say **"open Context Drop"** (optionally with a name: "open Context Drop for Fix login"). The agent returns a link, and the page opens with that chat selected. Then:

1. Paste (Ctrl/⌘+V) screenshots, text, or URLs anywhere on the page, drop files on it, or use **Choose files…**.
2. Optionally add an instruction.
3. Press **Send to <chat>**. The submission is locked to that chat, and its status appears under **Sent to this chat**.

The sidebar lists every connected chat across both agents. Drafts are kept per chat and survive refreshes, tab switches, and service restarts.

## Delivery and status

| Host | How a send reaches the chat | Status you'll see |
| - | - | - |
| Claude Code | MCP channel notification into the live session (`notifications/claude/channel`) | **Pushed (unconfirmed)**, because Claude Code doesn't acknowledge channel events. Becomes **Retrieved** when the agent calls `read_drop`. |
| Codex | `codex queue --thread <id>`, Codex's own command for queueing a message into an existing session | **Delivered** when Codex returns a queued-message id. Becomes **Retrieved** when the agent calls `read_drop`. |

Other states: **Queued** (saved locally), **Delivering**, **Uncertain** (the outcome is unknown, for example a timeout or an adapter that died mid-push; Retry asks for confirmation because it may duplicate), **Failed** (retained, with the reason, and retryable), **Cancelled**, **Expired**.

- Each send has a client-generated id. Double clicks, retries after a lost response, and refreshes never create a second submission.
- Order is preserved within a chat; nothing overtakes an in-flight or uncertain item.
- If a Claude Code session isn't connected, sends stay queued for that chat. They go out when the same session (same session id, e.g. `claude --resume`) reconnects. Nothing is ever routed by label or project folder.

## Limits and formats

PNG, JPEG, WebP, UTF-8 text/Markdown/code files, text-based PDFs (text is extracted; failures are shown), and http(s) links (never fetched). Types are detected from file contents. Other types are rejected with a message, and already-staged items are kept. Limits: 25 MiB per file, 10 items and 100 MiB per submission.

Retention: drafts and undelivered submissions are kept 7 days; attachments are kept 24 hours after delivery. You can clear a draft, cancel a queued item, delete local copies, or disconnect a chat at any time. Deleting local data does not remove anything already in the agent's transcript, and once sent, the agent may share content with its model provider as usual.

## Security

- The service listens on 127.0.0.1 only. It checks `Host` (DNS rebinding) and `Origin`, and requires bearer keys: one for the page and a separate one for the agent adapters. The keys are stored in `~/.context-drop/keys.json` (mode 600). The page receives its key in the URL fragment and removes it from the address bar.
- Each chat can only read its own submissions.
- Uploads are stored under random names outside the plugin. Previews are served as images or inert `text/plain` with `nosniff` and a sandbox CSP, and are never executed.
- The agent is told that attachment contents are source material, not instructions.
- `~/.context-drop/service.log` records ids, states, and errors only, never contents or keys.

## Layout

```
.claude-plugin/plugin.json   Claude Code manifest (MCP server + channel)
.codex-plugin/plugin.json    Codex manifest → codex.mcp.json
skills/context-drop/         Shared skill for both hosts
src/service.ts               Local service: HTTP API, page, storage, queues, Codex delivery
src/store.ts                 Destinations, drafts, submissions, validation, retention
src/mcp.ts                   MCP server (--host claude|codex): open/list/read/acknowledge/close_drop + channel push
src/client.ts                Finds, starts, or upgrades the shared service
src/pdf.ts                   Minimal PDF text extraction
web/                         The page (no framework)
```

## Tests

```bash
npm test
```

Covers validation, limits, retention, idempotent send, ordering, cancel/retry, auth/origin/host checks, inert previews, Codex delivery (success, failure, timeout → uncertain) using a fake `codex`, Claude long-poll and channel push through a real MCP subprocess, per-chat ownership, and 10-destination routing with duplicate titles in one project folder.

## Verification status (2026-10-02)

Verified live on Linux (WSL2) with Claude Code 2.1.287 and Codex CLI 0.160.0:

- **Claude Code**: the plugin loads and the skill triggers. The destination binds to the real session id without the user entering an id. Idle push was delivered in ~150 ms, and the agent read the image through `read_drop`. A send during a turn was delivered without disrupting it (the turn had backgrounded its shell command). After `/exit`, a send showed as queued with the chat offline, then was delivered on `claude --resume`.
- **Codex CLI**: the plugin loads, the skill reads `$CODEX_THREAD_ID`, and `open_drop` binds to that thread. A send was **Delivered** with Codex's queued-message id. On the thread's next turn the message was injected, the agent called `read_drop`, and it saw the image.
- **Browser page** (headless Chrome): paste of text, URLs, and images; unsupported-type rejection; separate drafts when switching chats; double-click send creating one submission; cancel; rename; keyboard focus; labeled controls; no horizontal scroll at 380 px; a stale link to an unknown chat doesn't fall back to another chat.

Not yet verified (PRD release gates still open):

- **Codex desktop app**: `codex queue` writes to the shared Codex queue, but delivery into a conversation open in the desktop app (and on Windows) hasn't been observed. Per the PRD, this needs evidence before claiming P0 07/08 for Codex desktop.
- A Codex thread that is mid-turn in an interactive TUI or the desktop app (the queue is consumed at a turn boundary).
- Windows: npm installs `codex` as a `.cmd` shim; set `CONTEXT_DROP_CODEX_BIN` to the native executable if delivery fails with "not found".
- Channel distribution beyond `--dangerously-load-development-channels`, and pilot usability targets.

## Configuration

| Variable | Purpose |
| - | - |
| `CONTEXT_DROP_HOME` | Data directory (default `~/.context-drop`) |
| `CONTEXT_DROP_CODEX_BIN` | Path to the `codex` executable used for delivery |
| `CONTEXT_DROP_NO_BROWSER` | Don't auto-open the page; just return the link |

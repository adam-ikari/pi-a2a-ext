# omp A2A Bridge

[简体中文](README_ZN.md)

The extension starts an MCP server endpoint on the host's `session_start` (MCP `2025-11-25`, Streamable HTTP, bound to `127.0.0.1` by default). A remote omp points its `mcp.json` at it and can then call the tools of the host's `Main` session (`read`/`bash`/`edit`…), running against the host's real files and shell. The host does no model inference — takes the request, runs the tool, returns the result, spends no tokens.

## How it works

```mermaid
graph TB
    subgraph Remote["🖥️ remote omp (MCP client)"]
        Client["🔌 MCP client<br/>mcp__omp-host__read"]
    end

    subgraph Host["🏠 host omp (MCP server)"]
        direction TB
        Serve["⚙️ src/server.ts<br/>Bun.serve · auth + protocol<br/>tools/list · tools/call"]
        Bridge["🌉 src/bridge.ts<br/>pi.getAllTools() · Main session"]
        Tools["🛠️ host's real tools<br/>read · bash · edit"]

        Serve -->|"getToolByName().execute()"| Bridge
        Bridge --> Tools
    end

    Client -->|"HTTP/JSON-RPC<br/>2025-11-25 · Bearer token"| Serve

    classDef client fill:#FFE66D,stroke:#F08C00,color:#000
    classDef server fill:#4ECDC4,stroke:#0B7285,color:#fff
    classDef tool fill:#A8DADC,stroke:#1864AB,color:#000
    class Client client
    class Serve,Bridge server
    class Tools tool
```

- The extension starts `Bun.serve` on `session_start` and implements MCP `2025-11-25`'s `initialize` / `tools/list` / `tools/call`, answering with plain JSON (no SSE).
- The tool catalog comes from the host's current session (`pi.getAllTools()`); execution always routes to `getToolByName` on the host's `Main` session, so calls run the host's own tool implementations.
- The catalog is the host registry as-is; the bridge does not filter it (see [Security and boundaries](#security-and-boundaries)).
- Remote calls involve no model inference at all: the host only receives a request, runs a tool, and returns the result.

## Install

On any machine, from the git URL:

```sh
omp install https://github.com/adam-ikari/pi-a2a-ext.git
```

That installs it into `~/.omp/plugins/node_modules/pi-a2a-ext`. To remove it:

```sh
omp plugin uninstall pi-a2a-ext
```

Already have a checkout? `omp install .` from the repo root links that copy
instead of fetching — handy while developing. The `pi.extensions` field in
`package.json` is what tells omp which entry file to load, so do not remove it.

`omp install` takes a **directory or a git URL, not a `.tgz`** — pointing it at a
tarball fails with `ENOTDIR`. A GitHub `owner/repo` shorthand is rejected as an
invalid package name; use the full `https://….git` URL.

All of the above was measured. **But the end-to-end path — `omp install <git-url>`
on a clean machine, host startup, MCP handshake — has no automated check**: the
host resolves its plugin directory independently of `HOME`, so the probe that
simulated a fresh machine was really re-testing the stale install in the real
`~/.omp`. `bun run test:install` now covers only whether the published package is
self-contained (manifest, `files[]`, the entry's relative-import graph). See
[docs/testing.md](docs/testing.md).

If you would rather bypass the plugin manager, `./scripts/install.sh` symlinks
straight into `~/.omp/agent/extensions/` and additionally verifies the link
resolves and the modules the entry point imports are present. It takes
`--status` (report state, non-zero if broken) and `--uninstall`; set
`OMP_AGENT_DIR` to target somewhere other than `~/.omp/agent`.

> Do not replace any of these with a bare
> `ln -s "$PWD/extensions/a2a-bridge.ts" ...`. That one-liner only works when
> `$PWD` happens to be the repo root; run it from anywhere else and it silently
> links a path that does not exist, and the bridge simply never comes up.

On first start the bridge generates its own config, token and file sandbox
under `~/.omp/agent/`, so there is nothing else to set up per machine.

After starting the host omp, the notification bar shows:

```
A2A bridge listening on http://127.0.0.1:<port> (token <first 6 chars>…)
```

`<port>` is the actual listening port (random by default).

## Configuration

The config file is `~/.omp/agent/a2a-bridge.json`, generated on first start with mode `0600` (created at that mode, so there is no permission window):

```json
{ "port": 0, "token": "<base64url 32B>", "host": "127.0.0.1" }
```

| Field | Meaning |
| --- | --- |
| `port` | `0` = random port; set a number to pin it |
| `token` | Bearer token, generated on first start |
| `host` | Listen address, default `127.0.0.1` (a warning is added if you change it to `0.0.0.0`) |
Only those three. **There is no tool allow/deny list and no file sandbox** — the bridge makes no permission decision of its own, so adding such fields to the config has no effect (unknown fields are ignored).

`A2A_BRIDGE_CONFIG` overrides the config path; `A2A_BRIDGE_AUDIT` overrides the audit log path.

Validation is **fail-closed**: a present-but-malformed field (`port` not an integer or out of range, `host` not a non-empty string) makes the extension refuse to start and report an error. The one exception is `token`: when missing or invalid it is regenerated and **written back to the config**, so it stays stable across restarts.

Config edits take effect on the **next host restart**; to change only the token at runtime, use `/a2a rotate` (immediate, and the old token stops working at once).

### Commands

Inside a host session:

- `/a2a` — show the current listen address, port, token prefix, file sandbox root and size cap (`files disabled` when the sandbox is unavailable)
- `/a2a rotate` — rotate the token (update the remote `mcp.json` afterwards)
- `/a2a token` — print the full token (the status line only shows a prefix)

## Remote connection example

The remote omp's `mcp.json`:

```json
{
  "mcpServers": {
    "omp-host": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Once connected, the remote side sees tools like `mcp__omp-host__read` and `mcp__omp-host__bash` and can call them directly.

## Cross-machine forwarding

Loopback-only by default, never exposed to the network. Forward the port over SSH from the remote machine:

```sh
ssh -L <localport>:127.0.0.1:<port> user@host
```

Then set `mcp.json`'s `url` to `http://127.0.0.1:<localport>/`.

## Approval

Remote calls reuse the host's approval gate (`ExtensionToolWrapper`) entirely and open no additional permissions:

- The host's default `approvalMode` is `yolo` → straight through, no approval step.
- If the host configures a tool as `prompt` in `tools.approval` **and** the host has an interactive UI (TUI), the remote call raises an Approve/Deny prompt; once the user confirms, it continues and the result returns by the same path.
- With no interactive UI (measured in rpc mode; print takes the same no-UI path but is untested), a `prompt` approval **neither executes the command nor returns**: the request hangs indefinitely (measured ≥90s) while the host waits for a UI answer that can never arrive. **Callers must impose their own timeout**; a hung call leaves a `start` record with no matching `done` in the audit log (see below), so it is detectable.

## File transfer

The bridge ships no file tools. To move files between machines, use the host's own tools (the remote side sees `mcp__omp-host__read`, `mcp__omp-host__bash`, …), or SSH for large payloads:

```sh
scp ./data.tar user@host:~/data.tar
```

The bridge sets no `fileRoot`, no `deny` list, and does not interpret paths — calls land on the host's real files and shell, and the host's own configuration decides what is permitted (see "Security and boundaries").

## Devices

The agent runs on a server, the device is plugged into your machine, and nothing crosses the USB in between. The host exposes devices in two shapes, and both pass through unchanged.

**Toolchains (`bash`).** `adb`, `idf.py`, serial tools and flashers are not omp tools — they are commands on this machine. `bash` is in `tools/list`, so a remote client runs them directly:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "bash", "arguments": { "command": "adb devices -l" } } }
```

Execution lands in the local shell, so whatever is on `PATH` is reachable: with the Android SDK installed, `adb` is callable; with ESP-IDF installed, `idf.py flash` is. Port monitors and register pokes work the same way.

**Mounted devices (`xd://`).** The host mounts some tools as virtual devices. **They are not in `tools/list`** — they are driven through the `path` argument of `read` / `write`:

```json
{ "name": "read",  "arguments": { "path": "xd://" } }                    // list mounted devices
{ "name": "read",  "arguments": { "path": "xd://debug" } }               // docs + JSON schema
{ "name": "write", "arguments": { "path": "xd://debug", "content": { … } } }  // execute
```

The listing is decided by the host at runtime — it depends on which extensions are installed and which devices are attached. Measured on this machine: `xd://debug` (a DAP debugger), `xd://lsp`, `xd://ast_edit`.

**Calling `xd://` directly through `tools/call` is refused** (`not exposed`): a device is not a tool name, and only the `path` of `read` / `write` reaches it. That is the host's shape; the bridge does not rewrite it.

## Security and boundaries

- **The token is full tool-execution authority (under the default config)**: the host's default `approvalMode: yolo` means anyone holding the token can execute any exposed tool (including `bash`) directly in the host session with no approval step; only tools the host configures as `prompt` have a gate that can stop them (see [Approval](#approval) for the no-UI case). Keep the config file at `0600` and out of version control.
- **The bridge makes no permission decision**: `tools/list` is the host session's registry (`pi.getAllTools()`), passed through verbatim with no filtering. It therefore includes `hidden` tools and tools the host currently has disabled for its own model — **whatever permissions omp has are the permissions the bridge has**. There is no second list such as `deny`: two lists can disagree, and no code defines which wins. To tighten anything, configure the host's own tool permissions; the bridge stays out of it.
- **Execution goes through the host's native tools**: `tools/call` routes to `getToolByName().execute()` on the host's `Main` session with the real `session.settings` and `ExtensionContext ui` injected, so the host's approval gate (`ExtensionToolWrapper`) applies as usual. The bridge implements no approval logic of its own.
- **Calls and the list share one source**: `tools/call` only accepts names that appear in `tools/list`; aliases (such as `xd://bash`) and unregistered names are refused, and a refusal does not distinguish "filtered" from "nonexistent" (so it does not leak whether a name exists).
- Loopback-only by default; if you really do expose it, the firewall is your responsibility.
- **Sessions are mandatory**: every message except `initialize` must carry `Mcp-Session-Id` (missing → 400, unknown or idle past 24h → 404). At most 64 sessions are tracked, with the least-recently-seen evicted beyond that; every hit refreshes the idle timer.
- **Audit log**: every remote `tools/call` writes two JSONL records — `{ts,id,sid,phase:"start",tool,args}` at dispatch and `{ts,id,sid,phase:"done",tool,isError,args}` on completion (paired by the same `id`; `sid` is that call's `Mcp-Session-Id`, so under a shared token each call is attributable to a client session; the args summary is truncated to 1KB) — to `~/.omp/agent/a2a-bridge.log`, mode 0600, rotating to `.1` past 512KB. **A `start` with no `done` means the call was dispatched but never completed** (typically: an approval hung for want of a UI); if rotation lands mid-call, the paired records can end up split across `.1` and the current file. Audit write failures never affect the call. Strings longer than 120 characters in the args are recorded as `<len:N,sha256:first 8>` so the log never holds payloads.
- If the configured port is busy, the bridge falls back to an ephemeral port and warns (update the port in the remote `mcp.json`).

How this differs from computer use (guessing pixel coordinates on a screenshot) is in [docs/computer-use.md](docs/computer-use.md).

The full wire contract — request/response shapes, processing order, session lifecycle and the error-code table — is in [docs/protocol.md](docs/protocol.md).

Online docs (GitHub Pages, published on push): <https://adam-ikari.github.io/pi-a2a-ext/>

v1 boundaries:

- Tools only (`tools/list` + `tools/call`); no resources, no prompts.
- No SSE push, no call cancellation.
- Always routed to the host's `Main` session.
- Static Bearer token, no OAuth.
- No concurrency or rate limiting.

Design trade-off (read this before adding a feature):

- The bridge sends the call and adds no meaning on the way. A capability the host's own `read`/`bash`/`edit` can express gets no new tool; paths are not judged here; the catalog is not filtered on permission grounds — **whatever permissions omp has are the permissions the bridge has**. Give the bridge one opinion of its own and it becomes a second omp.
- A bridge-owned tool bypasses the host's approval gate, so it would need its own sandbox. **That is one decision with two halves, and they have to go together**: dropping only the sandbox leaves a hole nobody guards.


## Troubleshooting

- **401 `unauthorized`**: the token does not match. The remote `mcp.json`'s `Authorization` header must equal the config's `token`; update the remote side after `/a2a rotate`.
- **400 `missing mcp-session-id` / 404 `unknown session`**: every message except `initialize` needs the session header. Sessions are in-memory in the host process — they all die when the host restarts and are reclaimed after 24h idle; run `initialize` again for a new session (a well-behaved MCP client library does this automatically).
- **Cannot connect / wrong port**: if the configured port is busy at host startup, the bridge falls back to a random port and warns in the notification bar — use the actual port shown there or in `/a2a` to update `mcp.json`.
- **A call never returns**: the host has no interactive UI and the tool's approval is `prompt` (see [Approval](#approval)) — the command does not execute, but neither does the call return; the caller must impose its own timeout, and the audit log shows a `start` with no `done` for that call (see the audit-log bullet under [Security and boundaries](#security-and-boundaries)).
- **500 `internal error`**: an internal server fault; the response body is deliberately detail-free (to avoid leaking), and the real cause is in the host's stderr as `[a2a-bridge] internal error: …`.
- **Config edits do not take effect**: external edits to `a2a-bridge.json` (such as `port`) need a host restart; only `/a2a rotate` applies live at runtime.
- **`bun test` version guard fails** (development): the installed `@oh-my-pi/pi-*` is out of sync with the pin/lock — `bun install` restores it; an `omp --version` that differs from the pin only warns, so update the two exact versions in `package.json` when you upgrade the host.

## Development

```sh
bun install

bun run typecheck     # type check
bun run lint          # lint + format check (Biome; fix with bunx biome check --write .)
bun test              # unit tests: test/*.test.ts (protocol/auth/config/exposure gate/audit/version guard)
bun run test:smoke    # real E2E (needs a local omp; no model credentials)
bun run test:hardening # real-host hardening checks, 29 items (needs a local omp)
bun run test:approval  # approval-boundary discriminating check, ~95s (needs a local omp)
bun run test:install  # published-package self-containment check, 17 items (npm pack + import graph; no host needed)
./scripts/install.sh   # install the extension into ~/.omp/agent/extensions (--status / --uninstall)
bun run website        # local docs site preview (Docusaurus) at http://localhost:3000; first run `cd website && bun install`
```

What each test covers, the preconditions for the real-host checks, and how to read their verdicts (including the approval check's VERDICT A/B/C semantics) are in [docs/testing.md](docs/testing.md).

Dependency note: `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai` are pinned to **exact versions** in `devDependencies`, kept in step with the host omp version, and used only for type checking and unit tests. **Do not load them from `node_modules` at runtime** — the host omp's `omp:legacy-pi-shim` redirects those imports to the same modules bundled inside the host, which is what lets module-level singletons like `AgentRegistry.global()` be shared; update both version numbers when upgrading omp. `bun test` includes a **version guard**: an installed devDep that differs from the pin fails outright, and an `omp --version` that differs from the pin only warns.

File layout:

| Path | Responsibility |
| --- | --- |
| `extensions/a2a-bridge.ts` | Extension entry point: starts the server on `session_start`, registers `/a2a` |
| `src/server.ts` | `Bun.serve` + JSON-RPC (MCP 2025-11-25, plain JSON responses), sessions and version negotiation |
| `src/bridge.ts` | Tool catalog and execution (`pi.getAllTools` / AgentRegistry Main session), exposure-intersection decision |
| `src/config.ts` | Config load/save, field validation, token generation |
| `src/auth.ts` | Bearer token verification (timing-safe comparison) |
| `src/audit.ts` | Audit log for remote calls (two-phase JSONL `start`/`done`, rotation) |

Change history: [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).

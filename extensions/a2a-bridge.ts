import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildCallTool, buildToolCatalog, hasMainSession } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

let server: { port: number; fellBack: boolean; stop(): void } | null = null;
let cfg: BridgeConfig | null = null;

export default function a2aBridge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_ev, ctx) => {
		if (server) return; // idempotent
		try {
			cfg = await loadConfig();
			if (!existsSync(configPath())) await saveConfig(cfg);
			server = await startServer(cfg, {
				getTools: buildToolCatalog(pi),
				callTool: buildCallTool(pi, ctx),
				serverInfo: () => ({ name: "omp-a2a-bridge", version: "0.1.0" }),
			});
			const url = `http://${cfg.host}:${server.port}/`;
			if (server.fellBack) {
				ctx.ui.notify(
					`A2A bridge: configured port ${cfg.port} is busy — bound ${server.port} instead; update remote mcp.json`,
					"warning",
				);
			}
			const tokenBrief = cfg.token.slice(0, 6);
			ctx.ui.notify(`A2A bridge listening on ${url} (token ${tokenBrief}…)`);
			if (cfg.host === "0.0.0.0") {
				ctx.ui.notify("A2A bridge bound to 0.0.0.0 — ensure firewall restricts access", "warning");
			}
		} catch (e) {
			// Leave no half-initialized state: a failed start must not let
			// `/a2a rotate` report success for a server that never bound.
			server?.stop();
			server = null;
			cfg = null;
			ctx.ui.notify(`A2A bridge failed to start: ${(e as Error)?.message ?? String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		// The server is a process-level resource, but this event is per session: a task
		// subagent's runner gets its own handlers, and finishing (or idle-parking) that
		// subagent emits it while the Main session is alive. Stopping here would take the
		// endpoint down with a session that was never ours to serve.
		if (hasMainSession()) return;
		server?.stop();
		server = null;
		cfg = null;
	});

	pi.registerCommand("a2a", {
		description: "Show A2A bridge status, rotate its token with `a2a rotate`, or show the full token with `a2a token`.",
		handler: async (args, ctx) => {
			try {
				if (args.trim() === "rotate") {
					if (!server || !cfg) {
						ctx.ui.notify("A2A bridge not running", "error");
						return;
					}
					const next = generateToken();
					// Persist first, then hand the new token to the live server: the server reads
					// `cfg.token` per request, so assigning before a failed write would rotate the
					// running bridge while the file still holds the old token — and the operator
					// gets an error saying nothing happened.
					await saveConfig({ ...cfg, token: next });
					cfg.token = next;
					ctx.ui.notify("A2A token rotated — update remote mcp.json");
					return;
				}
				if (args.trim() === "token") {
					if (!server || !cfg) {
						ctx.ui.notify("A2A bridge not running", "error");
						return;
					}
					ctx.ui.notify(`A2A token: ${cfg.token}`);
					return;
				}
				if (!server || !cfg) {
					ctx.ui.notify("A2A bridge not running", "error");
					return;
				}
				const url = `http://${cfg.host}:${server.port}/`;
				ctx.ui.notify(`A2A bridge on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port})`);
			} catch (e) {
				ctx.ui.notify(`A2A command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { auditLogPath } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { buildFileTools } from "../src/filetools.ts";
import { startServer } from "../src/server.ts";

let server: { port: number; fellBack: boolean; stop(): void } | null = null;
let cfg: BridgeConfig | null = null;
let fileRoot: string | null = null;

export default function a2aBridge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_ev, ctx) => {
		if (server) return; // idempotent
		try {
			cfg = await loadConfig();
			if (!existsSync(configPath())) await saveConfig(cfg);
			// The config/audit paths are declared here so a root that would
			// contain them is refused instead of quietly listing the token.
			const files = buildFileTools(cfg, { protectedPaths: [configPath(), auditLogPath()] });
			// A broken sandbox root disables file transfer only: the host tools
			// are still useful, and every file call keeps failing with the same
			// clear error, so there is nothing to "half start".
			try {
				fileRoot = await files.rootReal();
			} catch (e) {
				fileRoot = null;
				ctx.ui.notify(`A2A file transfer disabled: ${(e as Error)?.message ?? String(e)}`, "warning");
			}
			server = await startServer(cfg, {
				getTools: buildToolCatalog(pi, cfg, files.tools),
				callTool: buildCallTool(pi, ctx, cfg, files.tools),
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
			if (fileRoot) {
				ctx.ui.notify(
					`A2A file transfer enabled: root ${fileRoot}, max ${Math.round(cfg.maxFileBytes / 1048576)}MB/file`,
				);
			}
			if (cfg.host === "0.0.0.0") {
				ctx.ui.notify("A2A bridge bound to 0.0.0.0 — ensure firewall restricts access", "warning");
			}
		} catch (e) {
			// Leave no half-initialized state: a failed start must not let
			// `/a2a rotate` report success for a server that never bound.
			server?.stop();
			server = null;
			cfg = null;
			fileRoot = null;
			ctx.ui.notify(`A2A bridge failed to start: ${(e as Error)?.message ?? String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		server?.stop();
		server = null;
		cfg = null;
		fileRoot = null;
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
					cfg.token = generateToken();
					await saveConfig(cfg);
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
				const files = fileRoot ? `files ${fileRoot} (<=${Math.round(cfg.maxFileBytes / 1048576)}MB)` : "files disabled";
				ctx.ui.notify(`A2A bridge on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port}, ${files})`);
			} catch (e) {
				ctx.ui.notify(`A2A command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}

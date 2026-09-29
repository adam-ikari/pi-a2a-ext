import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import clsx from "clsx";
import styles from "./index.module.css";

const FEATURES = [
	{
		title: "使用指南",
		to: "/docs/",
		description: "安装、配置、远程 mcp.json 接入、审批语义与安全边界（源：README）。",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
				<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" />
				<path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5A1.5 1.5 0 0 0 20 18.5v-13Z" />
			</svg>
		),
	},
	{
		title: "协议参考",
		to: "/docs/protocol",
		description: "wire 契约：传输约定、处理顺序、会话生命周期、桥自带文件传输工具、错误码总表。",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
				<path d="m8 8-4 4 4 4" />
				<path d="m16 8 4 4-4 4" />
				<path d="m13.5 5-3 14" />
			</svg>
		),
	},
	{
		title: "测试与探针",
		to: "/docs/testing",
		description: "单测矩阵、真实宿主 E2E 四件套、审批判别探针 VERDICT A/B/C。",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
				<path d="M12 3 4.5 6v6c0 4.5 3 7.5 7.5 9 4.5-1.5 7.5-4.5 7.5-9V6L12 3Z" />
				<path d="m9 12 2 2 4-4.5" />
			</svg>
		),
	},
	{
		title: "变更日志",
		to: "/docs/changelog",
		description: "按日期分节的完整演进历史（源：CHANGELOG）。",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
				<circle cx="12" cy="12" r="8.5" />
				<path d="M12 7v5l3.5 2" />
			</svg>
		),
	},
];

const TERMINAL_LINES = [
	{ cls: "prompt", text: '远程 omp $ mcp__omp-host__read "src/server.ts"' },
	{ cls: "ok", text: "→ HTTP/JSON-RPC · Bearer token · Mcp-Session-Id" },
	{ cls: "muted", text: "宿主 omp · tools/call → Main 会话原生工具 · 零 LLM 调用" },
	{ cls: "ret", text: '← 200 { content: [ { type: "text", … } ] }' },
];

function Terminal() {
	return (
		<div className={styles.terminal} aria-hidden="true">
			<div className={styles.termBar}>
				<span className={styles.dot} style={{ background: "#f87171" }} />
				<span className={styles.dot} style={{ background: "#fbbf24" }} />
				<span className={styles.dot} style={{ background: "#34d399" }} />
				<span className={styles.termTitle}>loopback:8473 · MCP over HTTP</span>
			</div>
			<div className={styles.termBody}>
				{TERMINAL_LINES.map((l) => (
					<div key={l.text} className={clsx(styles.termLine, styles[l.cls])}>
						{l.text}
					</div>
				))}
			</div>
		</div>
	);
}

export default function Home() {
	const { siteConfig } = useDocusaurusContext();
	return (
		<Layout title="首页" description={siteConfig.tagline}>
			<header className={clsx("hero", styles.heroBanner)}>
				<div className="container">
					<div className={styles.heroGrid}>
						<div className={styles.heroText}>
							<div className={styles.badge}>MCP · protocol 2025-11-25 · zero-dep Bun.serve</div>
							<h1 className="hero__title">{siteConfig.title}</h1>
							<p className="hero__subtitle">{siteConfig.tagline}</p>
							<div className={styles.buttons}>
								<Link className="button button--lg button--primary" to="/docs/">
									快速开始
								</Link>
								<Link className={clsx("button button--lg", styles.outlineButton)} to="/docs/protocol">
									协议参考
								</Link>
							</div>
						</div>
						<div className={styles.heroVisual}>
							<Terminal />
							<div className={styles.statRow}>
								<div className={styles.stat}>
									<b>0</b>
									<span>运行时依赖</span>
								</div>
								<div className={styles.stat}>
									<b>100</b>
									<span>单元断言用例</span>
								</div>
								<div className={styles.stat}>
									<b>29</b>
									<span>宿主加固核验</span>
								</div>
								<div className={styles.stat}>
									<b>100MB</b>
									<span>单文件传输上限</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</header>

			<section className={styles.features}>
				<div className="container">
					<div className="row">
						{FEATURES.map((f) => (
							<div key={f.to} className={clsx("col col--3", styles.featureCard)}>
								<Link to={f.to} className={styles.featureLink}>
									<span className={styles.featureIcon}>{f.icon}</span>
									<h3>{f.title}</h3>
									<p>{f.description}</p>
								</Link>
							</div>
						))}
					</div>

					<div className={styles.quickstart}>
						<h2>三步接入</h2>
						<div className="row">
							<div className={clsx("col col--4", styles.stepCol)}>
								<span className={styles.stepNum}>1</span>
								<h3>装扩展</h3>
								<p>
									软链 <code>extensions/a2a-bridge.ts</code> 到 <code>~/.omp/agent/extensions/</code>
									，或本仓库作为 pi 插件。
								</p>
							</div>
							<div className={clsx("col col--4", styles.stepCol)}>
								<span className={styles.stepNum}>2</span>
								<h3>起宿主</h3>
								<p>
									宿主 omp 启动时通知栏显示 <code>A2A bridge listening on http://127.0.0.1:&lt;port&gt;</code>
									，token 自动生成并持久化。
								</p>
							</div>
							<div className={clsx("col col--4", styles.stepCol)}>
								<span className={styles.stepNum}>3</span>
								<h3>远程接入</h3>
								<p>
									远程 omp 的 <code>mcp.json</code> 指向 loopback（或 SSH 转发端口）即可调用宿主当前会话工具。
								</p>
							</div>
						</div>
					</div>
				</div>
			</section>
		</Layout>
	);
}

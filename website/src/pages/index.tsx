import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import styles from "./index.module.css";

// Kept in sync by hand with docusaurus.config.ts (title/tagline); avoids a
// runtime dependency on the useDocusaurusContext package layout.
const SITE_TITLE = "omp A2A Bridge";
const SITE_TAGLINE = "把运行中的 omp 变成一个 Streamable HTTP MCP 服务器";

const FEATURES = [
	{
		title: "使用指南",
		to: "/docs/",
		description: "安装、配置、远程 mcp.json 接入、审批语义与安全边界（源：README）。",
	},
	{
		title: "协议参考",
		to: "/docs/protocol",
		description: "wire 契约：传输约定、处理顺序、会话生命周期、错误码总表。",
	},
	{
		title: "测试与探针",
		to: "/docs/testing",
		description: "单测矩阵、真实宿主 E2E、审批判别探针 VERDICT A/B/C。",
	},
	{
		title: "变更日志",
		to: "/docs/changelog",
		description: "按日期分节的完整演进历史（源：CHANGELOG）。",
	},
];

export default function Home() {
	return (
		<Layout title="首页" description={SITE_TAGLINE}>
			<header className={`hero hero--primary ${styles.heroBanner}`}>
				<div className="container">
					<h1 className="hero__title">{SITE_TITLE}</h1>
					<p className="hero__subtitle">{SITE_TAGLINE}</p>
					<div className={styles.buttons}>
						<Link className="button button--secondary button--lg" to="/docs/">
							快速开始
						</Link>
						<Link className={`button button--outline button--lg ${styles.outlineButton}`} to="/docs/protocol">
							协议参考
						</Link>
					</div>
				</div>
			</header>
			<section className="container margin-vert--lg">
				<div className="row">
					{FEATURES.map((f) => (
						<div key={f.to} className={`col col--3 ${styles.featureCard}`}>
							<Link to={f.to} className={styles.featureLink}>
								<h3>{f.title}</h3>
								<p>{f.description}</p>
							</Link>
						</div>
					))}
				</div>
			</section>
		</Layout>
	);
}

/* GitHub Primer dark theme for prism-react-renderer (v1 theme format:
   `plain` + `styles`, which docusaurus 3.10's schema requires). */
export default {
	plain: { color: "#e6edf3", backgroundColor: "#0d1117" },
	styles: [
		{ types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#9198a1", fontStyle: "italic" } },
		{ types: ["punctuation"], style: { color: "#e6edf3" } },
		{
			types: ["property", "tag", "constant", "symbol", "deleted", "keyword", "selector"],
			style: { color: "#79c0ff" },
		},
		{ types: ["boolean", "number"], style: { color: "#79c0ff" } },
		{
			types: ["string", "char", "attr-value", "builtin", "inserted", "regex", "important"],
			style: { color: "#a5d6ff" },
		},
		{ types: ["operator", "entity", "url"], style: { color: "#4493f8" } },
		{ types: ["attr-name", "variable"], style: { color: "#ffab70" } },
		{ types: ["function", "class-name"], style: { color: "#d2a8ff" } },
		{ types: ["parameter"], style: { color: "#ffa657" } },
	],
};

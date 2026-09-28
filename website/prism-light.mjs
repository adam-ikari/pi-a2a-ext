/* GitHub Primer light theme for prism-react-renderer (v1 theme format:
   `plain` + `styles`, which docusaurus 3.10's schema requires). */
export default {
	plain: { color: "#1f2328", backgroundColor: "#eaeef2" },
	styles: [
		{ types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#59636e", fontStyle: "italic" } },
		{ types: ["punctuation"], style: { color: "#1f2328" } },
		{
			types: ["property", "tag", "constant", "symbol", "deleted", "keyword", "selector"],
			style: { color: "#0550ae" },
		},
		{ types: ["boolean", "number"], style: { color: "#0550ae" } },
		{
			types: ["string", "char", "attr-value", "builtin", "inserted", "regex", "important"],
			style: { color: "#0a3069" },
		},
		{ types: ["operator", "entity", "url"], style: { color: "#0969da" } },
		{ types: ["attr-name", "variable"], style: { color: "#953800" } },
		{ types: ["function", "class-name"], style: { color: "#8250df" } },
		{ types: ["parameter"], style: { color: "#953800" } },
	],
};

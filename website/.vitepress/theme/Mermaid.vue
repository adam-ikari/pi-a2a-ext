<script setup>
/**
 * Mermaid diagram component, loaded on demand.
 *
 * vitepress-plugin-mermaid registers its own <Mermaid> on the VitePress app
 * *entry* via a Vite transform, which put mermaid and all ~40 of its diagram
 * types into the entry chunk's import graph. VitePress then preloads the entry
 * chunk's dynamic imports on every page, so all of it was fetched on all seven
 * pages — including the four that contain no diagram at all (~1.5 MB).
 *
 * Registering this component through defineAsyncComponent in theme/index.ts
 * keeps mermaid in a separate chunk that the browser only requests when a page
 * actually renders a <Mermaid> tag. The props match what MermaidMarkdown emits
 * (see the fence renderer below), so the markdown side is unchanged.
 */

import settings from "virtual:mermaid-config";
import { useData } from "vitepress";
import { onMounted, onUnmounted, ref, toRaw } from "vue";

const props = defineProps({
	graph: { type: String, required: true },
	id: { type: String, required: true },
	class: { type: String, default: "mermaid" },
});

const { page } = useData();
const mermaidPageTheme = toRaw(page.value).frontmatter?.mermaidTheme || "";
const svg = ref(null);
let mut = null;
let mermaid = null;

async function renderChart() {
	if (!mermaid) return;
	const config = {
		...settings,
		// The page's own mermaidTheme wins, but dark mode overrides both: a
		// diagram has to stay legible when the reader flips the theme.
		...(mermaidPageTheme ? { theme: mermaidPageTheme } : {}),
		...(document.documentElement.classList.contains("dark") ? { theme: "dark" } : {}),
	};
	mermaid.initialize(config);
	// v-html does not re-render when the string is unchanged, and mermaid
	// replaces the DOM behind Vue's back — the salt forces a fresh node.
	const code = await mermaid.render(props.id, decodeURIComponent(props.graph));
	svg.value = `${code.svg} <span style="display:none">${Math.random().toString(36).slice(7)}</span>`;
}

onMounted(async () => {
	mermaid = (await import("mermaid")).default;
	await renderChart();
	// Dark-mode switches re-render every diagram on the page.
	mut = new MutationObserver(async () => {
		if (document.documentElement.classList.contains("dark")) await renderChart();
	});
	mut.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});

onUnmounted(() => mut?.disconnect());
</script>

<template>
	<div v-html="svg" :class="props.class" />
</template>

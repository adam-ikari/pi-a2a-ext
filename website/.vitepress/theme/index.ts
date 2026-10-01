/**
 * Custom theme: registers the mermaid component on demand.
 *
 * Everything else is the default theme. See Mermaid.vue for why the diagram
 * component is async rather than registered on the app entry.
 */
import DefaultTheme from "vitepress/theme";
import { defineAsyncComponent } from "vue";

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component(
			"Mermaid",
			defineAsyncComponent(() => import("./Mermaid.vue")),
		);
	},
};

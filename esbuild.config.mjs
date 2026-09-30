import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Node built-ins in both spellings ("fs" and "node:fs") stay external.
	external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	format: "cjs",
	target: "es2018",
	sourcemap: prod ? false : "inline",
	minify: prod,
	outfile: "main.js",
	logLevel: "info",
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}

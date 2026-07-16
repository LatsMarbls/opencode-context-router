import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Bundle all deps so the plugin has zero runtime dependencies
  noExternal: ["js-yaml"],
  // Target is Bun/Node 20+ with modern JS
  target: "es2022",
  // npm/npx bin wrapper handles the shebang — no banner needed
});

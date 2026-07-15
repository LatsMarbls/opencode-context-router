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
  // Zero runtime deps — bundle nothing external
  noExternal: [],
  // Target is Bun/Node 20+ with modern JS
  target: "es2022",
  // npm/npx bin wrapper handles the shebang — no banner needed
});

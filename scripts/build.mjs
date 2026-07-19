// Builds the published CLI entry. The shell and games ship as source and are
// bundled by the host at startup, so this only needs to compile the server.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "info",
});

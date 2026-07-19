import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Locate the lan-party package root, whether we're running from src/ (dev,
 * `node src/cli.ts`) or from dist/ (published bundle). Needed to find the
 * shell, the SDK, and the bundled games relative to the install location.
 */
export function packageRoot(): string {
  let dir = import.meta.dirname;
  while (true) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "lan-party") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("lan-party package root not found");
    }
    dir = parent;
  }
}

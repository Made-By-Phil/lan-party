// Typechecking a game folder.
//
// esbuild strips types without checking them, so a game with hard type errors
// builds, runs, and passes the smoke test. Two shipped that way in the curated
// collection. Types are the cheapest bug-finder a game author has, and nothing
// in the pipeline was using them.

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./paths.ts";

export interface TypecheckResult {
  ok: boolean;
  /** Compiler diagnostics, already trimmed for a terminal. */
  errors: string[];
  /** True when TypeScript isn't installed, so nothing was checked. */
  skipped?: boolean;
}

/** Resolve the tsc bin from wherever the framework itself is installed. */
function findTsc(): string | null {
  try {
    const require = createRequire(join(packageRoot(), "package.json"));
    return require.resolve("typescript/bin/tsc");
  } catch {
    return null;
  }
}

/**
 * Typecheck one game folder against the SDK, using the same compiler options
 * the framework holds itself to. Returns diagnostics rather than throwing so
 * the caller can decide whether they are fatal.
 */
export async function typecheckGame(gameDir: string): Promise<TypecheckResult> {
  const tsc = findTsc();
  if (!tsc) return { ok: true, errors: [], skipped: true };

  const root = packageRoot();
  const work = mkdtempSync(join(tmpdir(), "lp-tsc-"));
  const configPath = join(work, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        types: [],
        typeRoots: [join(root, "node_modules/@types")],
        paths: {
          "lan-party/sdk": [join(root, "src/sdk.ts")],
          "lan-party/sdk/controls": [join(root, "src/controls.tsx")],
        },
      },
      include: [join(gameDir, "**/*.ts"), join(gameDir, "**/*.tsx")],
    }),
  );

  try {
    const out = await new Promise<string>((resolve) => {
      // cwd is the game folder so diagnostics read "client.tsx(16,3)" rather
      // than a long relative path back out of the temp config directory.
      const p = spawn(process.execPath, [tsc, "-p", configPath, "--pretty", "false"], {
        cwd: gameDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buf = "";
      p.stdout.on("data", (d) => (buf += String(d)));
      p.stderr.on("data", (d) => (buf += String(d)));
      p.on("error", () => resolve(""));
      p.on("exit", () => resolve(buf));
    });

    // tsc resolves diagnostic paths against the config's directory, which is a
    // temp dir, so every line arrives with a long ../../.. prefix. Cut it back
    // to a path the author recognises.
    const real = realpathSync(gameDir);
    const trim = (line: string): string => {
      for (const base of [gameDir, real]) {
        const at = line.indexOf(`${base}/`);
        if (at >= 0) return line.slice(at + base.length + 1);
      }
      return line;
    };

    const errors = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /error TS\d+/.test(l))
      .map(trim);
    return { ok: errors.length === 0, errors };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

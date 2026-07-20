import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { folderFor, installGame, readLockfile, removeGame } from "../src/install/install.ts";
import { findEntry, githubTarball, parseSource } from "../src/install/source.ts";
import { packageRoot } from "../src/server/paths.ts";

const shellDir = join(packageRoot(), "shell");
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLIENT = `import type { GameClientProps } from "lan-party/sdk";
export default function C({ game }: GameClientProps) { return <div>ok</div>; }`;

function makeGame(id: string, serverBody?: string): string {
  const dir = tmp("lp-src-");
  writeFileSync(
    join(dir, "game.json"),
    JSON.stringify({
      id,
      name: id,
      description: "",
      minPlayers: 1,
      maxPlayers: 4,
      teams: "none",
      tickRate: 0,
      displayMode: "device",
      engine: "^0.1.0",
    }),
  );
  writeFileSync(join(dir, "client.tsx"), CLIENT);
  writeFileSync(
    join(dir, "server.ts"),
    serverBody ??
      `import type { GameContext, GameServer } from "lan-party/sdk";
       export default function create(ctx: GameContext): GameServer {
         return { onAction() {}, getPublicState() { return { ok: true }; } };
       }`,
  );
  return dir;
}

function party(): { gamesDir: string; dataDir: string; shellDir: string } {
  const root = tmp("lp-party-");
  return { gamesDir: join(root, "games"), dataDir: join(root, ".lan-party"), shellDir };
}

describe("parseSource", () => {
  it("classifies each source form", () => {
    expect(parseSource("trivia")).toMatchObject({ kind: "registry", id: "trivia" });
    expect(parseSource("ana/trivia")).toMatchObject({ kind: "registry", id: "ana/trivia" });
    expect(parseSource("github:o/r")).toMatchObject({ kind: "github", owner: "o", repo: "r" });
    expect(parseSource("https://x/y.tar.gz")).toMatchObject({ kind: "url" });
    expect(parseSource("./local")).toMatchObject({ kind: "local" });
    expect(parseSource("/abs/path")).toMatchObject({ kind: "local" });
  });

  it("parses a repo subdir and ref", () => {
    expect(parseSource("github:o/r/games/x#v2")).toMatchObject({
      owner: "o",
      repo: "r",
      subdir: "games/x",
      ref: "v2",
    });
  });

  it("puts the trust boundary at the network, not at the filesystem", () => {
    // Local files could just be copied into games/ by hand, which runs them
    // with no prompt at all — so demanding --trust there would be theatre.
    expect(parseSource("./x").requiresTrust).toBe(false);
    expect(parseSource("trivia").requiresTrust).toBe(false);
    expect(parseSource("github:o/r").requiresTrust).toBe(true);
    expect(parseSource("https://x/y.tgz").requiresTrust).toBe(true);
  });

  it("builds a codeload URL", () => {
    expect(githubTarball(parseSource("github:o/r#main"))).toBe(
      "https://codeload.github.com/o/r/tar.gz/main",
    );
  });

  it("refuses nonsense rather than guessing", () => {
    expect(() => parseSource("")).toThrow();
    expect(() => parseSource("what is this?")).toThrow(/cannot understand/);
  });
});

describe("findEntry", () => {
  const index = {
    games: [
      { id: "ana/trivia", tarball: "a" },
      { id: "ben/trivia", tarball: "b" },
      { id: "ana/chess", tarball: "c" },
    ],
  };

  it("matches a full id", () => {
    expect(findEntry(index, "ana/trivia").tarball).toBe("a");
  });

  it("matches an unambiguous bare name", () => {
    expect(findEntry(index, "chess").tarball).toBe("c");
  });

  it("refuses to guess between two authors' games of the same name", () => {
    expect(() => findEntry(index, "trivia")).toThrow(/ambiguous/);
  });

  it("reports a missing game clearly", () => {
    expect(() => findEntry(index, "nope")).toThrow(/no game named/);
  });
});

describe("installGame", () => {
  it("installs a local folder and records it in the lockfile", async () => {
    const p = party();
    const r = await installGame(makeGame("ana/quiz"), p);
    expect(r.id).toBe("ana/quiz");
    expect(r.replaced).toBe(false);
    expect(existsSync(join(p.gamesDir, "ana__quiz", "game.json"))).toBe(true);

    const lock = readLockfile(p.dataDir);
    expect(lock.games["ana/quiz"]).toMatchObject({ dir: "ana__quiz", engine: "^0.1.0" });
  });

  it("refuses an uncurated network source without --trust", async () => {
    const p = party();
    await expect(installGame("github:someone/whatever", p)).rejects.toThrow(/--trust/);
  });

  it("rejects a game that never releases the event loop", async () => {
    const leaky = makeGame(
      "mallory/leaky",
      `import type { GameContext, GameServer } from "lan-party/sdk";
       export default function create(ctx: GameContext): GameServer {
         setInterval(() => {}, 50);
         return { onAction() {}, getPublicState() { return {}; } };
       }`,
    );
    const p = party();
    await expect(installGame(leaky, p)).rejects.toThrow(/smoke test failed/);
    // Nothing half-written is left behind for the host to trip over.
    expect(existsSync(join(p.gamesDir, "mallory__leaky"))).toBe(false);
    // Deliberately exceeds the default: this case waits out the smoke timeout.
  }, 20_000);

  it("accepts the same game once it disposes its timer", async () => {
    const fixed = makeGame(
      "mallory/leaky",
      `import type { GameContext, GameServer } from "lan-party/sdk";
       export default function create(ctx: GameContext): GameServer {
         const t = setInterval(() => {}, 50);
         return { dispose() { clearInterval(t); }, onAction() {}, getPublicState() { return {}; } };
       }`,
    );
    const p = party();
    await expect(installGame(fixed, p)).resolves.toMatchObject({ id: "mallory/leaky" });
  });

  it("rejects a game whose engine range excludes this host", async () => {
    const dir = makeGame("ana/future");
    const m = JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
    m.engine = "^9.0.0";
    writeFileSync(join(dir, "game.json"), JSON.stringify(m));
    await expect(installGame(dir, party())).rejects.toThrow(/needs engine \^9\.0\.0/);
  });

  it("warns when a game states no engine range but still installs it", async () => {
    const dir = makeGame("ana/unstated");
    const m = JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
    delete m.engine;
    writeFileSync(join(dir, "game.json"), JSON.stringify(m));
    const r = await installGame(dir, party());
    expect(r.warnings.join(" ")).toMatch(/engine/);
  });

  it("replaces an existing install in place", async () => {
    const p = party();
    await installGame(makeGame("ana/quiz"), p);
    const again = await installGame(makeGame("ana/quiz"), p);
    expect(again.replaced).toBe(true);
  });

  it("descends wrapper directories the way archives arrive", async () => {
    // Mirrors a GitHub tarball: repo-ref/ wrapping the real game folder.
    const outer = tmp("lp-wrap-");
    const inner = join(outer, "games-repo-main");
    mkdirSync(inner, { recursive: true });
    const game = makeGame("ana/wrapped");
    for (const f of ["game.json", "client.tsx", "server.ts"]) {
      writeFileSync(join(inner, f), readFileSync(join(game, f)));
    }
    const r = await installGame(outer, party());
    expect(r.id).toBe("ana/wrapped");
  });
});

describe("removeGame", () => {
  it("removes the folder and the lockfile entry", async () => {
    const p = party();
    await installGame(makeGame("ana/quiz"), p);
    expect(removeGame("ana/quiz", p)).toBe(true);
    expect(existsSync(join(p.gamesDir, "ana__quiz"))).toBe(false);
    expect(readLockfile(p.dataDir).games["ana/quiz"]).toBeUndefined();
  });

  it("reports when there was nothing to remove", () => {
    expect(removeGame("nobody/nothing", party())).toBe(false);
  });
});

describe("folderFor", () => {
  it("keeps the namespace visible without nesting directories", () => {
    expect(folderFor("ana/quiz")).toBe("ana__quiz");
  });
});

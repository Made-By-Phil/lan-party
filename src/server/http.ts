import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#141420">
<title>LAN Party</title>
<link rel="stylesheet" href="/app.css">
</head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body>
</html>
`;

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * `buildDir` is read per request rather than captured: a rebuild swaps in a new
 * directory, and pointing at the new one is how the swap becomes visible. No
 * files move under a request that is already streaming.
 */
export function createHttpServer(getBuildDir: () => string): http.Server {
  return http.createServer((req, res) => {
    const buildDir = getBuildDir();
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/" || url === "/index.html" || url === "/shared") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    // Static assets from the build dir only; normalize to block traversal.
    const rel = normalize(url).replace(/^([/\\]|\.\.)+/, "");
    const file = join(buildDir, rel);
    if (file.startsWith(buildDir) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

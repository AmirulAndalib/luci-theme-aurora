/**
 * Copyright (C) 2025 eamonxg <eamonxiong@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */

import tailwindcss from "@tailwindcss/vite";
import browserslist from "browserslist";
import { exec } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { browserslistToTargets } from "lightningcss";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { minify as terserMinify } from "terser";
import { promisify } from "util";
import {
  defineConfig,
  loadEnv,
  Plugin,
  ResolvedConfig,
  ViteDevServer,
} from "vite";

const execAsync = promisify(exec);

const CURRENT_DIR = process.cwd();
const PROJECT_ROOT = resolve(CURRENT_DIR, "..");
const BUILD_OUTPUT = resolve(PROJECT_ROOT, "htdocs/luci-static");

function createLuciJsCompressPlugin(): Plugin {
  let outDir: string;

  return {
    name: "luci-js-compress",
    apply: "build",
    configResolved(config: ResolvedConfig) {
      outDir = config.build.outDir;
    },
    async generateBundle() {
      const srcDir = resolve(CURRENT_DIR, "src/resource");
      const jsFiles = (await readdir(srcDir, { recursive: true })).filter(
        (f) => f.endsWith(".js"),
      );
      await Promise.all(
        jsFiles.map(async (relPath) => {
          const normalized = relPath.replace(/\\/g, "/");
          try {
            const sourceCode = await readFile(join(srcDir, relPath), "utf-8");
            const compressed = await terserMinify(sourceCode, {
              parse: { bare_returns: true },
              compress: false,
              mangle: false,
              format: { comments: false, beautify: false },
            });
            const outputPath = join(outDir, "resources", normalized);
            await mkdir(dirname(outputPath), { recursive: true });
            await writeFile(outputPath, compressed.code || sourceCode, "utf-8");
          } catch (error: any) {
            console.error(
              `${tag("JS Compress")} src/resource/${normalized}: ${error?.message}`,
            );
          }
        }),
      );
    },
  };
}

// On-demand third-party patches: serve src/media/patches/<page>.css at
// /luci-static/aurora/patches/<page>.css in dev. Without this, header.ut's patch
// <link> falls through to the OpenWrt proxy (404 / stale router asset) and patch
// edits don't trigger HMR. Matched per request so new patch files work without
// a dev-server restart.
const PATCH_PUBLIC_PREFIX = "/luci-static/aurora/patches/";
const PATCH_SRC_DIR = resolve(CURRENT_DIR, "src/media/patches");

// Theme assets (public/aurora/**: images, fonts): serve the copy in this
// checkout at /luci-static/aurora/<path>. Without this, header.ut's logo,
// favicon, webmanifest and font references fall through to the OpenWrt proxy
// and resolve against the *installed* package, so an icon or font added here
// 404s until the package is rebuilt and reinstalled. Only files that exist
// locally are rewritten — everything else still proxies through.
const ASSET_PUBLIC_PREFIX = "/luci-static/aurora/";
const ASSET_SRC_DIR = resolve(CURRENT_DIR, "public/aurora");

// Resolves a request path under public/aurora/, or null when it escapes the
// directory (../) or names something that is not a file there.
function localAsset(relPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  const file = resolve(ASSET_SRC_DIR, decoded);
  if (!file.startsWith(ASSET_SRC_DIR + sep)) return null;

  return existsSync(file) && statSync(file).isFile() ? decoded : null;
}

function createLocalServePlugin(): Plugin {
  const cssRoutes: Record<string, string> = {
    "/luci-static/aurora/main.css": "/src/media/main.css",
    "/luci-static/aurora/login.css": "/src/media/login.css",
  };
  const jsRoutes: Record<string, string> = {
    "/luci-static/resources/view/aurora/sysauth.js":
      "src/resource/view/aurora/sysauth.js",
    "/luci-static/resources/menu-aurora.js": "src/resource/menu-aurora.js",
  };

  // Any theme CSS (entries, partials, patches) or served JS change must force
  // a full reload: proxied LuCI pages link /luci-static/... URLs, so Vite's
  // granular css-update never matches them and would silently do nothing.
  const MEDIA_SRC_DIR = resolve(CURRENT_DIR, "src/media").replace(/\\/g, "/");
  const reloadJsFiles = new Set(
    Object.values(jsRoutes).map((src) =>
      resolve(CURRENT_DIR, src).replace(/\\/g, "/"),
    ),
  );

  return {
    name: "local-serve-plugin",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const [pathname, search] = req.url.split("?");
        const cssTarget = cssRoutes[pathname];
        if (cssTarget) {
          req.url = cssTarget + (search ? `?${search}` : "");
          return next();
        }
        if (
          pathname.startsWith(PATCH_PUBLIC_PREFIX) &&
          pathname.endsWith(".css")
        ) {
          const file = basename(pathname);
          if (existsSync(join(PATCH_SRC_DIR, file))) {
            req.url =
              `/src/media/patches/${file}` + (search ? `?${search}` : "");
            return next();
          }
        }
        if (pathname.startsWith(ASSET_PUBLIC_PREFIX)) {
          const asset = localAsset(pathname.slice(ASSET_PUBLIC_PREFIX.length));
          if (asset) {
            req.url = `/aurora/${asset}` + (search ? `?${search}` : "");
            return next();
          }
        }
        const jsPath = jsRoutes[pathname];
        if (jsPath) {
          try {
            const code = await readFile(resolve(CURRENT_DIR, jsPath), "utf-8");
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Cache-Control", "no-store");
            res.statusCode = 200;
            res.end(code);
            return;
          } catch (err: any) {
            console.error(
              `${tag("Serve")} ${pathname} → cannot read ${jsPath}: ${err?.message ?? err}`,
            );
          }
        }
        next();
      });
    },
    handleHotUpdate({ file, server }) {
      const nf = file.replace(/\\/g, "/");
      const isThemeCss =
        nf.startsWith(MEDIA_SRC_DIR + "/") && nf.endsWith(".css");
      if (isThemeCss || reloadJsFiles.has(nf)) {
        console.log(
          `${tag("Serve")} ${relative(CURRENT_DIR, file)} → full reload`,
        );
        server.ws.send({ type: "full-reload", path: "*" });
        return [];
      }
    },
  };
}

// Mock pages: render saved LuCI page snapshots against the live theme, so a
// third-party app's page can be styled without the app (or a device) installed.
// Snapshots live in .dev/mocks/*.html and are served at /mocks/<name>.html
// with the Vite HMR client injected, so theme edits (main.css, components,
// patches/*.css, served JS) trigger the existing full-reload in handleHotUpdate.
// Any third-party asset a snapshot needs (the app's own css/js, e.g.
// qmodem-next.css) goes under .dev/mocks/static/ mirroring its /luci-static/…
// URL and is served as-is (no HMR). See "Mock Pages" in .dev/docs/DEVELOPMENT.md.
const MOCK_ROUTE = "/mocks";
const MOCKS_DIR = resolve(CURRENT_DIR, "mocks");
const MOCKS_STATIC_DIR = join(MOCKS_DIR, "static");

const MOCK_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function mockContentType(file: string): string {
  const ext = file.slice(file.lastIndexOf("."));
  return MOCK_MIME[ext] ?? "application/octet-stream";
}

// Inject the Vite HMR client so a served snapshot joins the WS channel and
// receives handleHotUpdate's full-reload broadcast on any theme source change.
function injectHmrClient(html: string): string {
  if (html.includes("/@vite/client")) return html;
  const tag = `\n    <script type="module" src="/@vite/client"></script>\n`;
  return html.includes("</head>")
    ? html.replace("</head>", `${tag}  </head>`)
    : tag + html;
}

// A snapshot is static DOM. Left alone, LuCI's runtime (luci.js + the inline
// `new LuCI(...)` bootstrap) boots, polls the backend, gets 403 (no session)
// and pops the "Session expired" modal. Neutralise it for mock rendering:
// strip the scripts that phone home (luci.js/cbi.js and /cgi-bin/ endpoints)
// and pre-define a no-op `L`/`LuCI` stub so the remaining inline bootstraps
// (`new LuCI(...)`, `L.require(...)`) run harmlessly. Theme CSS/JS and the
// theme's own inline scripts (dark mode, toolbar) are untouched; framework-
// dependent theme JS such as menu-aurora simply no-ops — the captured DOM is
// already fully rendered, so a static review still looks right.
const MOCK_RUNTIME_GUARD = `<script>
    (function () {
      var stub = new Proxy(function () {}, {
        get: function () { return stub; },
        apply: function () { return stub; },
        construct: function () { return stub; },
      });
      window.L = stub;
      window.LuCI = stub;
    })();
    </script>`;

function neutralizeLuciRuntime(html: string): string {
  const stripped = html.replace(
    /<script\b[^>]*\bsrc="[^"]*(?:\/luci-static\/resources\/(?:luci|cbi)\.js|\/cgi-bin\/)[^"]*"[^>]*>\s*<\/script>/gi,
    "",
  );
  return stripped.includes("</head>")
    ? stripped.replace(/<head\b[^>]*>/i, (m) => `${m}\n    ${MOCK_RUNTIME_GUARD}`)
    : MOCK_RUNTIME_GUARD + stripped;
}

function renderMockIndex(files: string[]): string {
  const rows = files.length
    ? files
        .map(
          (f) =>
            `<li><a href="${MOCK_ROUTE}/${encodeURIComponent(f)}">${f}</a></li>`,
        )
        .join("\n      ")
    : `<li class="empty">No snapshots yet — drop a page's HTML into <code>.dev/mocks/</code></li>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Aurora mock pages</title>
  <style>
    body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#1a1a1a}
    h1{font-size:20px;margin:0 0 4px}
    p.sub{color:#888;font-size:13px;margin:0 0 24px}
    ul{list-style:none;padding:0;margin:0}
    li{margin:8px 0}
    li a{display:inline-block;padding:8px 14px;border:1px solid #d0d0d0;border-radius:8px;text-decoration:none;color:#0a7d4b;font-weight:500}
    li a:hover{background:#f5f5f5}
    li.empty{color:#888}
    code{background:#f0f0f0;padding:1px 6px;border-radius:4px;font-size:13px}
    @media(prefers-color-scheme:dark){body{background:#111;color:#eee}li a{border-color:#333;color:#4ade80}li a:hover{background:#1c1c1c}code{background:#222}}
  </style>
</head>
<body>
  <h1>Aurora mock pages</h1>
  <p class="sub">Saved snapshots served against the live theme. Edit theme CSS/JS → the open page hot-reloads.</p>
  <ul>
      ${rows}
  </ul>
</body>
</html>`;
}

function createMockPlugin(): Plugin {
  return {
    name: "mock-pages-plugin",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const [pathname] = req.url.split("?");

        // Index of available snapshots.
        if (pathname === MOCK_ROUTE || pathname === `${MOCK_ROUTE}/`) {
          const files = existsSync(MOCKS_DIR)
            ? readdirSync(MOCKS_DIR)
                .filter((f) => f.endsWith(".html"))
                .sort()
            : [];
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(renderMockIndex(files));
          return;
        }

        // A single snapshot, with the HMR client injected.
        if (
          pathname.startsWith(`${MOCK_ROUTE}/`) &&
          pathname.endsWith(".html")
        ) {
          const name = basename(decodeURIComponent(pathname));
          const file = resolve(MOCKS_DIR, name);
          if (!file.startsWith(MOCKS_DIR + sep) || !existsSync(file)) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              `<!doctype html><meta charset="utf-8"><p>Mock not found: ${name} — <a href="${MOCK_ROUTE}/">back to index</a>`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          const snapshot = await readFile(file, "utf-8");
          res.end(injectHmrClient(neutralizeLuciRuntime(snapshot)));
          return;
        }

        // Third-party static drop-ins the snapshot references (the app's own
        // css/js) — reached only when local-serve didn't already claim the path.
        if (pathname.startsWith("/luci-static/")) {
          let file: string;
          try {
            file = resolve(
              MOCKS_STATIC_DIR,
              decodeURIComponent(pathname.slice(1)),
            );
          } catch {
            return next();
          }
          if (
            file.startsWith(MOCKS_STATIC_DIR + sep) &&
            existsSync(file) &&
            statSync(file).isFile()
          ) {
            res.statusCode = 200;
            res.setHeader("Content-Type", mockContentType(file));
            res.setHeader("Cache-Control", "no-store");
            res.end(await readFile(file));
            return;
          }
        }

        next();
      });
    },
  };
}

const UT_TEMPLATE_DIR = resolve(PROJECT_ROOT, "ucode/template/themes/aurora");
const UT_REMOTE_DIR = "/usr/share/ucode/luci/template/themes/aurora";

// Key selection is ssh's own job: ssh-agent or a Host block in ~/.ssh/config.
// ConnectTimeout applies to every ssh call: template pushes gate /cgi-bin page
// loads, so an unreachable device must fail fast instead of hanging them.
const SSH_ARGS =
  "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5";

function tag(name: string): string {
  return `${new Date().toLocaleTimeString("en-US")} [${name}]`;
}

const utTag = () => tag("UT Sync");

const parseHost = (sshHost: string): string => sshHost.split("@").pop()!;

function reportSshError(err: any, sshHost: string): void {
  const host = parseHost(sshHost);
  const stderr = err?.stderr || err?.message || "";

  if (
    stderr.includes("Host key verification failed") ||
    stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
  ) {
    console.error(`\n${utTag()} SSH host key mismatch for ${host}.`);
    console.error(`${utTag()} The device may have been reflashed. Run:\n`);
    console.error(`  ssh-keygen -R ${host}\n`);
  } else if (
    stderr.includes("Permission denied") ||
    stderr.includes("Authentication failed")
  ) {
    console.error(`\n${utTag()} SSH authentication failed for ${sshHost}.`);
    console.error(
      `${utTag()} Run \`pnpm setup:router\` to configure passwordless login.\n`,
    );
  } else if (
    stderr.includes("Connection refused") ||
    stderr.includes("Connection timed out") ||
    stderr.includes("No route to host")
  ) {
    console.error(
      `\n${utTag()} Cannot reach ${host}. Check that the device is online and SSH is enabled.\n`,
    );
  } else {
    console.error(`\n${utTag()} SSH connection failed: ${stderr}\n`);
  }
}

async function checkSshConnection(sshHost: string): Promise<boolean> {
  try {
    await execAsync(`ssh ${SSH_ARGS} "${sshHost}" echo ok`);
    console.log(`${utTag()} SSH connection to ${sshHost} verified.`);
    return true;
  } catch (err: any) {
    reportSshError(err, sshHost);
    return false;
  }
}

function createUtSyncPlugin(sshHost: string): Plugin {
  let dirty = false;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Filenames whose change events triggered the pending sync — the push itself
  // is always the whole directory, this only makes the log say what changed.
  const pending = new Set<string>();

  // The templates are tiny, so every sync just pushes the whole directory in
  // one tarball streamed over ssh stdin — OpenSSH 9+ scp defaults to the SFTP
  // protocol, which Dropbear on OpenWrt does not ship a server for. Note the
  // tar extract only adds/overwrites: deleting or renaming a local .ut leaves
  // the old file on the device until a reinstall or manual cleanup.
  const pushAll = () =>
    execAsync(
      `tar -C "${UT_TEMPLATE_DIR}" -cf - . | ssh ${SSH_ARGS} "${sshHost}" "mkdir -p '${UT_REMOTE_DIR}' && tar -xf - -C '${UT_REMOTE_DIR}'"`,
    );

  const flush = (server: ViteDevServer): Promise<void> => {
    if (!flushing) {
      flushing = (async () => {
        while (dirty) {
          dirty = false;
          const files = [...pending];
          pending.clear();
          const started = Date.now();
          try {
            await pushAll();
            const what = files.length ? files.join(", ") : "all templates";
            console.log(
              `${utTag()} ${what} → ${sshHost} (${Date.now() - started}ms)`,
            );
            server.ws.send({ type: "full-reload", path: "*" });
          } catch (err: any) {
            files.forEach((f) => pending.add(f));
            reportSshError(err, sshHost);
            break;
          }
        }
        flushing = null;
      })();
    }
    return flushing;
  };

  const markDirty = (server: ViteDevServer) => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => flush(server), 150);
  };

  return {
    name: "ut-sync-plugin",
    apply: "serve",
    configureServer(server) {
      console.log(
        `${utTag()} ${relative(PROJECT_ROOT, UT_TEMPLATE_DIR)}/*.ut → ${sshHost}:${UT_REMOTE_DIR}`,
      );

      // Full push on startup so edits made while the server was down (or a
      // freshly flashed device) can't leave the router stale.
      checkSshConnection(sshHost).then((ok) => {
        if (ok) markDirty(server);
      });

      server.watcher.add(UT_TEMPLATE_DIR);
      const onTemplateEvent = (file: string) => {
        if (file.startsWith(UT_TEMPLATE_DIR) && file.endsWith(".ut")) {
          pending.add(basename(file));
          markDirty(server);
        }
      };
      server.watcher.on("add", onTemplateEvent);
      server.watcher.on("change", onTemplateEvent);

      // Hold page loads until pending template pushes land, so a proxied
      // render never uses a stale template.
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/cgi-bin") || (!dirty && !flushing)) {
          return next();
        }
        if (timer) clearTimeout(timer);
        console.log(`${utTag()} Holding ${req.url} until templates sync…`);
        flush(server).then(
          () => next(),
          () => next(),
        );
      });
    },
  };
}

function createRedirectPlugin(): Plugin {
  return {
    name: "redirect-plugin",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(302, { Location: "/cgi-bin/luci" });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, CURRENT_DIR);
  // VITE_OPENWRT_HOST is just the router address — a bare IP/hostname like
  // 192.168.1.1 (host:port and http:// URL forms also work). The web proxy
  // target and the .ut-sync ssh target are both derived from it; ssh key
  // selection etc. belongs in ~/.ssh/config, not here.
  const OPENWRT_RAW = env.VITE_OPENWRT_HOST || "192.168.1.1";
  const OPENWRT = new URL(
    /^https?:\/\//.test(OPENWRT_RAW) ? OPENWRT_RAW : `http://${OPENWRT_RAW}`,
  );
  const OPENWRT_URL = OPENWRT.origin;
  const OPENWRT_SSH_HOST = `root@${OPENWRT.hostname}`;
  const DEV_HOST = env.VITE_DEV_HOST || "127.0.0.1";
  const DEV_PORT = Number(env.VITE_DEV_PORT) || 5173;

  return {
    plugins: [
      tailwindcss(),
      createRedirectPlugin(),
      createLocalServePlugin(),
      createMockPlugin(),
      createUtSyncPlugin(OPENWRT_SSH_HOST),
      createLuciJsCompressPlugin(),
    ],
    css: {
      lightningcss: {
        targets: browserslistToTargets(
          browserslist("last 4 versions, Firefox ESR, not dead"),
        ),
      },
    },
    build: {
      outDir: BUILD_OUTPUT,
      emptyOutDir: false,
      cssMinify: "lightningcss",
      rollupOptions: {
        input: {
          main: resolve(CURRENT_DIR, "src/media/main.css"),
          login: resolve(CURRENT_DIR, "src/media/login.css"),
          // On-demand third-party patches: one entry per page, output to
          // aurora/patches/<page>.css (the `patches/` key prefix lands them there
          // via assetFileNames below). header.ut links the matching one per page.
          ...Object.fromEntries(
            (existsSync(PATCH_SRC_DIR) ? readdirSync(PATCH_SRC_DIR) : [])
              .filter((f) => f.endsWith(".css"))
              .map((f) => [
                `patches/${f.slice(0, -4)}`,
                join(PATCH_SRC_DIR, f),
              ]),
          ),
        },
        output: { assetFileNames: "aurora/[name].[ext]" },
      },
    },
    server: {
      host: DEV_HOST,
      port: DEV_PORT,
      proxy: {
        "/luci-static": {
          target: OPENWRT_URL,
          changeOrigin: true,
          secure: false,
        },
        "/cgi-bin": {
          target: OPENWRT_URL,
          changeOrigin: true,
          secure: false,
          // We write every response ourselves in `proxyRes` below, so the Vite
          // client can be injected into proxied LuCI HTML.
          selfHandleResponse: true,
          configure: (proxy) => {
            // Force an uncompressed upstream response: the HTML injection below
            // treats the body as UTF-8 text and would corrupt a gzipped payload.
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.removeHeader("accept-encoding");
            });
            proxy.on("proxyRes", (proxyRes, req, res) => {
              const status = proxyRes.statusCode ?? 200;
              const ct = proxyRes.headers["content-type"] || "";
              if (!ct.includes("text/html")) {
                res.writeHead(status, proxyRes.headers);
                proxyRes.pipe(res);
                return;
              }
              const chunks: Buffer[] = [];
              proxyRes.on("data", (c: Buffer) => chunks.push(c));
              proxyRes.on("end", () => {
                let html = Buffer.concat(chunks).toString("utf-8");
                const client = `<script type="module" src="/@vite/client"></script>`;
                if (
                  html.includes("</head>") &&
                  !html.includes("/@vite/client")
                ) {
                  html = html.replace("</head>", `${client}\n\t</head>`);
                }
                const { "transfer-encoding": _, ...headers } = proxyRes.headers;
                res.writeHead(status, {
                  ...headers,
                  "content-length": Buffer.byteLength(html),
                });
                res.end(html);
              });
            });
          },
        },
      },
      headers: { "Cache-Control": "no-store" },
    },
    resolve: {
      alias: {
        "@": resolve(CURRENT_DIR, "src"),
        "@assets": resolve(CURRENT_DIR, "src/assets"),
      },
    },
  };
});

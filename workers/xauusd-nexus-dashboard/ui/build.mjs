// The Nexus UI build: esbuild bundles src/main.tsx, Tailwind 4 (through PostCSS) builds src/index.css, and
// dist/index.html links the hashed files. It replaces vite (2026-11-17, owner): every vite release depends on
// picomatch, which has an unfixed high npm advisory (GHSA-fc5q-39xc-vjpf), and dependency-audit is a required check.
//
// What the Worker expects (workers/xauusd-nexus-dashboard/src): dist/ served as Workers Static Assets, the hashed
// files under /assets/ (cached as immutable), the HTML shell revalidated, external module scripts and stylesheets
// only (no inline script), as before.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = `${root}/dist`;

/** Each imported .css file goes through PostCSS with Tailwind 4 before esbuild bundles it. */
const tailwindPlugin = {
  name: "tailwind",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, "utf8");
      const out = await postcss([tailwind({ base: root, optimize: { minify: true } })]).process(css, { from: args.path });
      return { contents: out.css, loader: "css" };
    });
  }
};

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/assets`, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/main.tsx" },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist/assets",
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "[name]-[hash]",
  publicPath: "/assets",
  jsx: "automatic",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning",
  plugins: [tailwindPlugin]
});

// The entry's script and stylesheet, by their hashed names.
const outputs = Object.entries(result.metafile.outputs);
const entry = outputs.find(([, o]) => o.entryPoint === "src/main.tsx");
if (!entry) throw new Error("no entry output");
const [jsPath, jsOut] = entry;
const cssPath = jsOut.cssBundle;
const href = (p) => `/${relative(dist, `${root}/${p}`).split("\\").join("/")}`;

const html = await readFile(`${root}/index.html`, "utf8");
const tag = '<script type="module" src="/src/main.tsx"></script>';
if (!html.includes(tag)) throw new Error("index.html no longer has the entry script tag");
const shell = html
  .replace(tag, "")
  .replace("</head>", `${cssPath ? `<link rel="stylesheet" crossorigin href="${href(cssPath)}">\n` : ""}<script type="module" crossorigin src="${href(jsPath)}"></script>\n</head>`);
await writeFile(`${dist}/index.html`, shell);

const size = (p) => `${(result.metafile.outputs[p].bytes / 1024).toFixed(1)} KiB`;
for (const [p] of outputs) console.log(`${p}  ${size(p)}`);
console.log("dist/index.html");

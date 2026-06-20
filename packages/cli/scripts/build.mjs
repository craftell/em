import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const packageRoot = path.resolve(import.meta.dirname, "..");
const appDist = path.resolve(packageRoot, "../app/dist");
const outDir = path.resolve(packageRoot, "dist");

if (!fs.existsSync(appDist)) {
  throw new Error("packages/app/dist is missing. Run `pnpm --filter @emviz/app build` before building emviz.");
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--emitDeclarationOnly", "--declaration", "--declarationMap"], {
  cwd: packageRoot,
  stdio: "inherit"
});

await build({
  entryPoints: [path.resolve(packageRoot, "src/index.ts")],
  outfile: path.resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);'
  }
});

fs.chmodSync(path.resolve(outDir, "index.js"), 0o755);
fs.cpSync(appDist, path.resolve(outDir, "app"), { recursive: true });

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const bump = process.argv[2];
const allowedBumps = new Set(["patch", "minor", "major"]);
const root = path.resolve(import.meta.dirname, "..");
const cliDir = path.join(root, "packages/cli");
const cliPackagePath = path.join(cliDir, "package.json");

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit"
  });
}

function read(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8"
  }).trim();
}

function assertCleanWorktree() {
  const status = read("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error(`Release requires a clean worktree.\n\n${status}`);
  }
}

if (!allowedBumps.has(bump)) {
  console.error("Usage: pnpm release:patch | pnpm release:minor | pnpm release:major");
  process.exit(1);
}

assertCleanWorktree();

run("npm", ["version", bump, "--no-git-tag-version"], { cwd: cliDir });
const nextVersion = JSON.parse(fs.readFileSync(cliPackagePath, "utf8")).version;
const tag = `emviz-v${nextVersion}`;

run("pnpm", ["install", "--lockfile-only"]);
run("pnpm", ["release:dry"]);
run("git", ["add", "packages/cli/package.json", "pnpm-lock.yaml"]);
run("git", ["commit", "-m", `Release emviz ${nextVersion}`]);
run("git", ["tag", tag]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);

console.log("");
console.log(`Release ${nextVersion} has been pushed and tagged as ${tag}.`);
console.log("Next steps:");
console.log("1. Wait for the GitHub Actions npm staging workflow to pass.");
console.log("2. Approve the staged package on npm with `npm stage approve <stage-id>`.");
console.log(`3. Verify with \`npm view emviz version\` and \`npx emviz@${nextVersion} --help\`.`);

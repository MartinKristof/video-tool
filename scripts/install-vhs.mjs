#!/usr/bin/env node
/**
 * Installs the VHS binary the terminal recorder needs into .tools/.
 *
 * Homebrew ships VHS 0.12.0, which runs the whole tape, prints "Creating
 * out.mp4...", then skips the ffmpeg encode and exits 0 without writing a file
 * (charmbracelet/vhs#787). Pinning 0.11.0 here keeps terminal renders working
 * regardless of what is on PATH.
 *
 * Runs from npm postinstall. Skips when .tools/vhs is already the pinned
 * version, and never fails the install: VHS only affects terminal projects, so
 * a download problem should not block `npm install`.
 *
 * Force a re-download:  node scripts/install-vhs.mjs --force
 * Skip entirely:        SKIP_VHS_INSTALL=1 npm install
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const VERSION = "0.11.0";
const TOOLS_DIR = path.resolve(import.meta.dirname, "..", ".tools");
const BINARY = path.join(TOOLS_DIR, process.platform === "win32" ? "vhs.exe" : "vhs");

// Release assets are named by Go's GOOS/GOARCH run through goreleaser's
// title-cased template, which does not match process.platform/process.arch.
const PLATFORMS = {
  darwin: "Darwin",
  linux: "Linux",
  win32: "Windows",
};
const ARCHS = {
  arm64: "arm64",
  x64: "x86_64",
  ia32: "i386",
  arm: "arm",
};

function assetName() {
  const platform = PLATFORMS[process.platform];
  const arch = ARCHS[process.arch];
  if (!platform || !arch) return null;
  if (platform === "Linux" && arch === "arm64" && process.platform !== "linux") return null;
  const ext = platform === "Windows" ? "zip" : "tar.gz";
  return `vhs_${VERSION}_${platform}_${arch}.${ext}`;
}

function installedVersion() {
  if (!fs.existsSync(BINARY)) return null;
  try {
    return execFileSync(BINARY, ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/** Pull a single file out of a gzipped tar without shelling out to tar. */
async function extractFromTarGz(archive, wantedSuffix, dest) {
  const buf = zlib.gunzipSync(archive);
  for (let offset = 0; offset + 512 <= buf.length; ) {
    const name = buf.toString("utf-8", offset, offset + 100).replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(buf.toString("utf-8", offset + 124, offset + 135).trim(), 8) || 0;
    const body = offset + 512;
    if (name.endsWith(wantedSuffix)) {
      fs.writeFileSync(dest, buf.subarray(body, body + size));
      return true;
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return false;
}

async function main() {
  if (process.env.SKIP_VHS_INSTALL) return;

  const force = process.argv.includes("--force");
  const current = installedVersion();
  if (!force && current?.includes(VERSION)) {
    console.log(`vhs ${VERSION} already in .tools, skipping.`);
    return;
  }

  const asset = assetName();
  if (!asset) {
    console.warn(
      `vhs: no ${VERSION} build for ${process.platform}/${process.arch}. ` +
        "Terminal renders will fall back to vhs on PATH.",
    );
    return;
  }

  if (asset.endsWith(".zip")) {
    console.warn(
      "vhs: Windows builds are not unpacked automatically. " +
        `Download ${asset} manually and point VHS_BIN at it.`,
    );
    return;
  }

  const url = `https://github.com/charmbracelet/vhs/releases/download/v${VERSION}/${asset}`;
  console.log(`vhs: downloading ${asset}`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const tmp = path.join(TOOLS_DIR, `.vhs-${process.pid}`);
  if (!(await extractFromTarGz(archive, "/vhs", tmp))) {
    throw new Error(`no vhs binary inside ${asset}`);
  }
  fs.chmodSync(tmp, 0o755);

  // Gatekeeper quarantines anything fetched over the network, so an unsigned
  // binary would be killed on first run.
  if (process.platform === "darwin") {
    try {
      execFileSync("xattr", ["-d", "com.apple.quarantine", tmp], { stdio: "ignore" });
    } catch {
      // Attribute absent, which is what we want anyway.
    }
  }

  fs.renameSync(tmp, BINARY);
  const installed = installedVersion();
  if (!installed?.includes(VERSION)) {
    throw new Error(`installed binary reports "${installed}", expected ${VERSION}`);
  }
  console.log(`vhs: installed ${installed} into .tools`);
}

main().catch((err) => {
  console.warn(`vhs: install failed (${err.message}).`);
  console.warn("Terminal renders will fall back to vhs on PATH. See README.");
});

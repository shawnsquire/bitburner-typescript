/**
 * RAM Audit Debug Tool
 *
 * Loops through all .js files on the home server, gets their RAM cost,
 * and produces:
 *   1. A terminal overview (sorted by RAM descending, grouped by folder)
 *   2. A detailed report written to /data/ram-audit.txt for external analysis
 *
 * Usage:
 *   run tools/debug/ram-audit.js
 *   run tools/debug/ram-audit.js --top 20     # Show top 20 by RAM
 */
import { NS } from "@ns";

interface FileInfo {
  path: string;
  ram: number;
  folder: string;
}

/** Folders to skip — runtime data, not scripts. */
const SKIP_PREFIXES = [
  "cache/",
  "data/",
];

function getFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return "(root)";
  return path.substring(0, slash);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["top", 30],
  ]) as { top: number; _: string[] };

  const topN = flags.top;

  // Get all .js files
  const allFiles = ns.ls("home").filter(f => {
    if (!f.endsWith(".js")) return false;
    for (const prefix of SKIP_PREFIXES) {
      if (f.startsWith(prefix)) return false;
    }
    return true;
  });

  // Collect RAM info
  const files: FileInfo[] = [];
  let totalRam = 0;
  let errorCount = 0;

  for (const path of allFiles) {
    const ram = ns.getScriptRam(path, "home");
    if (ram === 0) {
      errorCount++;
    }
    files.push({
      path,
      ram,
      folder: getFolder(path),
    });
    totalRam += ram;
  }

  // Sort by RAM descending
  const byRam = [...files].sort((a, b) => b.ram - a.ram);

  // Group by folder
  const byFolder = new Map<string, FileInfo[]>();
  for (const f of files) {
    const group = byFolder.get(f.folder) || [];
    group.push(f);
    byFolder.set(f.folder, group);
  }

  // Sort folders by total RAM
  const folderTotals = [...byFolder.entries()]
    .map(([folder, ffiles]) => ({
      folder,
      files: ffiles,
      totalRam: ffiles.reduce((s, f) => s + f.ram, 0),
      count: ffiles.length,
    }))
    .sort((a, b) => b.totalRam - a.totalRam);

  // === TERMINAL OVERVIEW ===

  ns.tprint(`\n\x1b[36m=== RAM AUDIT ===\x1b[0m`);
  ns.tprint(`  \x1b[2mTotal files:\x1b[0m ${files.length}`);
  ns.tprint(`  \x1b[2mTotal RAM:\x1b[0m  ${ns.format.ram(totalRam)}`);
  if (errorCount > 0) {
    ns.tprint(`  \x1b[31mErrors:\x1b[0m     ${errorCount} files returned 0 GB`);
  }

  // Top N by RAM
  ns.tprint(`\n  \x1b[36m--- Top ${topN} by RAM ---\x1b[0m`);
  for (let i = 0; i < Math.min(topN, byRam.length); i++) {
    const f = byRam[i];
    const ramStr = ns.format.ram(f.ram).padStart(10);
    const color = f.ram >= 100 ? "\x1b[31m" : f.ram >= 10 ? "\x1b[33m" : "\x1b[2m";
    ns.tprint(`    ${color}${ramStr}\x1b[0m  ${f.path}`);
  }

  // By folder
  ns.tprint(`\n  \x1b[36m--- By Folder ---\x1b[0m`);
  for (const { folder, count, totalRam: fRam } of folderTotals) {
    const ramStr = ns.format.ram(fRam).padStart(10);
    ns.tprint(`    ${ramStr}  ${folder}/ (${count} files)`);
  }

  // === DETAILED REPORT ===

  const lines: string[] = [];
  lines.push("RAM AUDIT REPORT");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total files: ${files.length}`);
  lines.push(`Total RAM: ${ns.format.ram(totalRam)}`);
  lines.push("");

  // All files sorted by RAM
  lines.push("=== ALL FILES BY RAM (descending) ===");
  lines.push("");
  lines.push(`${"RAM".padStart(10)}  ${"File"}`);
  lines.push(`${"---".padStart(10)}  ${"----"}`);

  for (const f of byRam) {
    lines.push(`${ns.format.ram(f.ram).padStart(10)}  ${f.path}`);
  }

  lines.push("");
  lines.push("=== BY FOLDER ===");
  lines.push("");

  for (const { folder, files: ffiles, totalRam: fRam, count } of folderTotals) {
    lines.push(`--- ${folder}/ (${count} files, ${ns.format.ram(fRam)}) ---`);
    const sorted = [...ffiles].sort((a, b) => b.ram - a.ram);
    for (const f of sorted) {
      lines.push(`  ${ns.format.ram(f.ram).padStart(10)}  ${f.path}`);
    }
    lines.push("");
  }

  // RAM tiers
  lines.push("=== RAM TIERS ===");
  lines.push("");

  const tiers = [
    { label: "100+ GB (very high — Singularity-heavy)", min: 100, max: Infinity },
    { label: "10-100 GB (high)", min: 10, max: 100 },
    { label: "5-10 GB (medium)", min: 5, max: 10 },
    { label: "2-5 GB (low)", min: 2, max: 5 },
    { label: "0-2 GB (minimal)", min: 0, max: 2 },
  ];

  for (const tier of tiers) {
    const tierFiles = byRam.filter(f => f.ram >= tier.min && f.ram < tier.max);
    lines.push(`${tier.label}: ${tierFiles.length} files`);
    for (const f of tierFiles) {
      lines.push(`  ${ns.format.ram(f.ram).padStart(10)}  ${f.path}`);
    }
    lines.push("");
  }

  // Write report
  const reportPath = "/data/ram-audit.txt";
  ns.write(reportPath, lines.join("\n"), "w");

  ns.tprint(`\n  \x1b[32mDetailed report written to:\x1b[0m ${reportPath}`);
  ns.tprint(`  \x1b[2mCopy from: cat ${reportPath}\x1b[0m`);
  ns.tprint("");
}

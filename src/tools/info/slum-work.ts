import { NS } from "@ns";
import { COLORS } from "/lib/utils";
import {
  analyzeAllCrimes,
  fmtMoney,
  fmtExp,
  fmtPercent,
} from "/controllers/crime";

const { green, yellow, cyan, dim, reset, bold } = COLORS;

export async function main(ns: NS): Promise<void> {
  ns.tprint(`\n${bold}${cyan}=== Slum Work Analysis ===${reset}\n`);

  const rows = analyzeAllCrimes(ns, "moneyPerMin");

  // Header
  const header = [
    pad("CRIME", 18),
    pad("CHANCE", 8),
    pad("TIME", 6),
    pad("$/MIN", 12),
    pad("HAK/m", 8),
    pad("STR/m", 8),
    pad("DEF/m", 8),
    pad("DEX/m", 8),
    pad("AGI/m", 8),
    pad("CHA/m", 8),
    pad("KRM/m", 8),
  ].join(" ");

  ns.tprint(`${dim}${header}${reset}`);
  ns.tprint(`${dim}${"-".repeat(header.length)}${reset}`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const color = i === 0 ? green : r.chance >= 0.5 ? yellow : dim;

    const row = [
      pad(r.crime, 18),
      pad(fmtPercent(r.chance), 8),
      pad(r.timeSec.toFixed(1) + "s", 6),
      pad(fmtMoney(r.moneyPerMin), 12),
      pad(fmtExp(r.hackExpPerMin), 8),
      pad(fmtExp(r.strExpPerMin), 8),
      pad(fmtExp(r.defExpPerMin), 8),
      pad(fmtExp(r.dexExpPerMin), 8),
      pad(fmtExp(r.agiExpPerMin), 8),
      pad(fmtExp(r.chaExpPerMin), 8),
      pad(r.karmaPerMin.toFixed(1), 8),
    ].join(" ");

    ns.tprint(`${color}${row}${reset}`);
  }

  // Best options summary
  ns.tprint(`\n${bold}${cyan}=== Best Options ===${reset}`);

  const bestMoney = rows[0];
  ns.tprint(
    `${green}Best $/min:${reset} ${bestMoney.crime} (${fmtMoney(bestMoney.moneyPerMin)}/min @ ${fmtPercent(bestMoney.chance)})`
  );

  const bestStr = [...rows].sort((a, b) => b.strExpPerMin - a.strExpPerMin)[0];
  if (bestStr.strExpPerMin > 0) {
    ns.tprint(
      `${yellow}Best STR:${reset}  ${bestStr.crime} (${fmtExp(bestStr.strExpPerMin)}/min)`
    );
  }

  const bestDex = [...rows].sort((a, b) => b.dexExpPerMin - a.dexExpPerMin)[0];
  if (bestDex.dexExpPerMin > 0) {
    ns.tprint(
      `${yellow}Best DEX:${reset}  ${bestDex.crime} (${fmtExp(bestDex.dexExpPerMin)}/min)`
    );
  }

  const bestAgi = [...rows].sort((a, b) => b.agiExpPerMin - a.agiExpPerMin)[0];
  if (bestAgi.agiExpPerMin > 0) {
    ns.tprint(
      `${yellow}Best AGI:${reset}  ${bestAgi.crime} (${fmtExp(bestAgi.agiExpPerMin)}/min)`
    );
  }

  const bestKarma = [...rows].sort((a, b) => b.karmaPerMin - a.karmaPerMin)[0];
  if (bestKarma.karmaPerMin > 0) {
    ns.tprint(
      `${dim}Best Karma:${reset} ${bestKarma.crime} (${bestKarma.karmaPerMin.toFixed(1)}/min)`
    );
  }

  const bestKills = [...rows].sort((a, b) => b.killsPerMin - a.killsPerMin)[0];
  if (bestKills.killsPerMin > 0) {
    ns.tprint(
      `${dim}Best Kills:${reset} ${bestKills.crime} (${bestKills.killsPerMin.toFixed(2)}/min)`
    );
  }
}

function pad(s: string, n: number): string {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s.padEnd(n, " ");
}

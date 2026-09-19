/**
 * Travel to Aevum (casino city) if not already there.
 *
 * RAM: ~4.1 GB total (1.6 base + travelToCity 2.0 + getPlayer 0.5) at SF4 level 3+
 * or inside BN4. Without SF4-3, travelToCity is charged at 16x (~34.1 GB total) —
 * see CLAUDE.md "Pitfalls" (singularity functions cost 16x at SF4 level 0-1).
 */
import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  const city = "Aevum";
  const player = ns.getPlayer();
  if (player.city === city) {
    ns.tprint(`Already in ${city}`);
    ns.toast(`Already in ${city}`, "info", 2000);
    return;
  }

  const success = ns.singularity.travelToCity(city);
  if (success) {
    ns.tprint(`SUCCESS Traveled to ${city}`);
    ns.toast(`Traveled to ${city}`, "success", 2000);
  } else {
    ns.tprint(`ERROR Failed to travel to ${city} (need $200k)`);
    ns.toast(`Failed to travel to ${city}`, "error", 3000);
  }
}

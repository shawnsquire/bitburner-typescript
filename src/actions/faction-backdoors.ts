/**
 * Faction Backdoors Action
 *
 * One-shot script that installs backdoors on the four hacking-faction servers
 * (CSEC, avmnite-02h, I.I.I.I, run4theh111z) for any that are rooted but not
 * yet backdoored. Connects hop-by-hop to each target, waits out the backdoor
 * install time, then returns to home.
 *
 * Usage: run actions/faction-backdoors.js
 */
import { NS } from "@ns";
import { discoverAllWithDepthAndPath, pathTo, pathToArray } from "/lib/utils";

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");

    const BACKDOOR = [
        "CSEC",
        "avmnite-02h",
        "I.I.I.I",
        "run4theh111z",
    ];
    const start = "home";

    for (const target of BACKDOOR) {
        const server = ns.getServer(target);
        if (!server.hasAdminRights) {
            ns.tprint(`You do not have root access to ${target}`);
            continue;
        }
        if (server.backdoorInstalled) continue;

        const { parentByHost } = discoverAllWithDepthAndPath(ns, start, 100);
        const path = pathToArray(parentByHost, target).slice(1);

        ns.tprint(`Backdooring ${target}`);
        ns.tprint(pathTo(parentByHost, target));
        try {
            for (const hop of path) {
                ns.singularity.connect(hop);
            }
            while (!ns.getServer(target).backdoorInstalled) {
                await ns.singularity.installBackdoor();
            }
            ns.tprint("Installed!");
        } catch (e) {
            ns.tprint(`ERROR: Failed to backdoor ${target}: ${String(e)}`);
        } finally {
            ns.singularity.connect("home");
        }
    }
}

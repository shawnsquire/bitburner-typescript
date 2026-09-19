import { NS } from "@ns";
import { COLORS, discoverAllWithDepthAndPath, pathToArray } from "/lib/utils";

export async function main(ns: NS) {
    ns.disableLog("ALL")
    ns.ui.openTail();

    const BACKDOOR = [
        "CSEC",
        "avmnite-02h",
        "I.I.I.I",
        "run4theh111z",
        "w0r1d_d43m0n",
    ];

    for (const host of BACKDOOR) {
        // Skip w0r1d_d43m0n before Red Pill
        if(!ns.serverExists(host)) { continue; }

        const server = ns.getServer(host);

        // Skip already backdoored servers
        if (server.backdoorInstalled) { continue; }

        const start = "home";

        const { parentByHost } = discoverAllWithDepthAndPath(ns, start, 100);
        const path = pathToArray(parentByHost, host);

        const rooted = server.hasAdminRights ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
        const reqHack =  server.hasAdminRights ? '' : `${COLORS.yellow}(Req. ${server.requiredHackingSkill} Hack)${COLORS.reset}`;

        ns.print(`${rooted} ${COLORS.cyan}${host}${COLORS.reset} ${reqHack}`)
        ns.print(path.map(x => `connect ${x}`).join("; ") + "; backdoor");
    }
}

import { NS, Server } from "@ns";
import { COLORS, getAllServers } from "/lib/utils";

const { red, green, reset } = COLORS;

export async function main(ns: NS): Promise<void> {
  const command = ns.args[0] as string | undefined;
  const servers = getAllServers(ns).map(h => ns.getServer(h)).filter(s => s.hasAdminRights);

  ns.tprint(`${servers.length} servers...`)

  switch (command) {
    case "ls":
    case "list":
      list(ns, servers);
      break;
    case "killall":
      ns.tprint("Killing all...")
      killall(ns, servers);
      break;
    case "cp":
    case "copy":
      ns.tprint("Copying...")
      copy(ns, servers, ns.args[1] as string);
      break;
    case "exec":
    case "run":
      ns.tprint("Running...")
      run(ns, servers, ns.args[1] as string, Number(ns.args[2]), ns.args.slice(3))
      break;
    default:
      ns.tprint(`${red}ERROR: No valid command given!${reset}`);
  }
}

function list(ns: NS, servers: Server[]): void {
  for (const server of servers) {
    ns.tprint(server.hostname);
  }
}

function killall(ns: NS, servers: Server[]): void {
  for (const server of servers) {
    ns.killall(server.hostname);
  }
}

function copy(ns: NS, servers: Server[], file: string): void {
  for (const server of servers) {
    ns.scp(file, server.hostname);
  }
}

function run(ns: NS, servers: Server[], script: string, threads: number, args: (string | number | boolean)[]): void {
  for (const server of servers) {
    if (server.maxRam === 0) continue;

    const scriptRam = ns.getScriptRam(script, server.hostname)
    if (scriptRam === 0) {
      ns.tprint(`${red}Failed on ${server.hostname}: ${script} not found (copy it there first)${reset}`);
      continue;
    }
    const freeRam = server.maxRam - server.ramUsed;
    const maxThreads = Math.floor(freeRam / scriptRam);
    const runThreads = threads > 0 ? Math.min(threads, maxThreads) : Math.min(maxThreads, 9999999999);
    if (runThreads <= 0) {
      ns.tprint(`${red}Failed on ${server.hostname}: Not enough RAM${reset}`)
      continue;
    }

    const res = ns.exec(script, server.hostname, runThreads, ...args)
    if (res !== 0) {
      ns.tprint(`${green}Success on ${server.hostname} with ${runThreads} threads.${reset}`);
    } else {
      ns.tprint(`${red}Failed on ${server.hostname}${reset}`)
    }
  }
}

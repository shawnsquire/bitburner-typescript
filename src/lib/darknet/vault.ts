/**
 * Darknet Password Vault
 *
 * Reads and writes `/data/darknet-vault.json`, the coordinator's durable
 * record of cracked passwords (`docs/design/2026-09-19-darknet.md` section 4).
 * The vault's `lastNodeReset` is compared against `ns.getResetInfo().lastNodeReset`
 * so a new BitNode starts with an empty vault instead of stale passwords for
 * hostnames that may no longer exist.
 *
 * Only `ns.read`, `ns.write` and `ns.fileExists` are touched, all 0 GB — safe
 * to import from the coordinator daemon without meaningfully affecting its RAM
 * budget. Not part of the darknet replication bundle (`DNET_BUNDLE` in
 * `lib/darknet/protocol.ts`): darknet-side workers never persist a vault of
 * their own, they only receive `Policy.vault` from home.
 *
 * Import with: import { loadVault, saveVault, ... } from "/lib/darknet/vault";
 */
import type { NS } from "@ns";
import type { Vault, VaultEntry } from "/lib/darknet/protocol";

export const VAULT_PATH = "/data/darknet-vault.json";

/** A fresh, empty vault stamped with the current BitNode's reset time. */
export function emptyVault(lastNodeReset: number): Vault {
  return { lastNodeReset, entries: {} };
}

function isVaultEntry(v: unknown): v is VaultEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.password !== "string") return false;
  if (typeof e.seenAt !== "number") return false;
  if (typeof e.fingerprint !== "object" || e.fingerprint === null) return false;
  const fp = e.fingerprint as Record<string, unknown>;
  return typeof fp.difficulty === "number" && typeof fp.modelId === "string" && typeof fp.passwordLength === "number";
}

/**
 * Parse a serialized vault. Returns null for anything that isn't well-formed
 * JSON matching the `Vault` shape (missing file, truncated write, a stray
 * file from an older format) so the caller can fall back to a fresh vault
 * instead of crashing on garbage. Malformed individual entries are dropped
 * rather than failing the whole parse.
 */
export function parseVault(raw: string): Vault | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.lastNodeReset !== "number") return null;
  if (typeof obj.entries !== "object" || obj.entries === null) return null;

  const entries: Record<string, VaultEntry> = {};
  for (const [host, v] of Object.entries(obj.entries as Record<string, unknown>)) {
    if (isVaultEntry(v)) entries[host] = v;
  }
  return { lastNodeReset: obj.lastNodeReset, entries };
}

export function serializeVault(vault: Vault): string {
  return JSON.stringify(vault);
}

/**
 * Load the vault from disk. Wipes it (returns an empty vault instead) when
 * the file is missing, unparseable, or was written under a different
 * `lastNodeReset` — i.e. before the current BitNode started.
 */
export function loadVault(ns: NS, lastNodeReset: number): Vault {
  if (!ns.fileExists(VAULT_PATH)) return emptyVault(lastNodeReset);
  const parsed = parseVault(ns.read(VAULT_PATH));
  if (!parsed || parsed.lastNodeReset !== lastNodeReset) return emptyVault(lastNodeReset);
  return parsed;
}

/** Overwrite the vault file with the current in-memory vault. */
export function saveVault(ns: NS, vault: Vault): void {
  ns.write(VAULT_PATH, serializeVault(vault), "w");
}

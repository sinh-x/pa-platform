import { BulletinStore } from "./store.js";
import type { Bulletin } from "./types.js";

// Ported from PA bulletins/guard.ts at frozen PA source on 2026-04-26.

export interface GuardResult {
  blocked: boolean;
  bulletin?: Bulletin;
}

export function isTeamBlocked(teamName: string, store = new BulletinStore()): GuardResult {
  try {
    for (const bulletin of store.readActive()) {
      if (bulletin.except.includes(teamName)) continue;
      if (bulletin.block === "all") return { blocked: true, bulletin };
      if (Array.isArray(bulletin.block) && bulletin.block.includes(teamName)) return { blocked: true, bulletin };
    }
  } catch {
    return { blocked: false };
  }
  return { blocked: false };
}

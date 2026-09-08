export function perUnitFor(members: number): number {
  if (members <= 20) return 4;
  if (members <= 40) return 3;
  return 2;   // floor: one spare candidate per member. Below this, siblings starve.
}

export function capFor(members: number): number {
  // Single-member groups keep today's retention: nothing is shared, so nothing is capped.
  if (members <= 1) return Infinity;
  return members * perUnitFor(members);
}

// BID_WON fires before the creative renders, and the creative then resolves its bid by adId.
export const RENDERED_GRACE_MS = 5000;
// hb_adid stays on the slot after the 2s reservation lapses, so GAM can still call the bid back.
export const TARGETED_GRACE_MS = 30000;

export function selectEvictions(
  entries: any[], cap: number, now: number, renderedGraceMs: number, targetedGraceMs: number,
): string[] {
  const evict: string[] = [];
  const candidates: any[] = [];

  entries.forEach((e) => {
    if (e.state === 'expired') { evict.push(e.adId); return; }
    if (e.state === 'rendered') {
      if (e.renderedAt == null || now - e.renderedAt >= renderedGraceMs) evict.push(e.adId);
      return;
    }
    // Reserved bids are neither counted nor evicted: trimming must never take a bid out from
    // under a pending render.
    if (e.state === 'reserved') return;
    if (e.targetedAt != null && now - e.targetedAt < targetedGraceMs) return;
    candidates.push(e);
  });

  if (cap !== Infinity && candidates.length > cap) {
    const kept = candidates
      .sort((a, b) => Number(b.cpm) - Number(a.cpm))   // Number(): cpm is a string post-conversion
      .slice(0, cap);
    const keptIds = new Set(kept.map((e) => e.adId));
    candidates
      .sort((a, b) => Number(a.cpm) - Number(b.cpm))   // ascending order: lowest cpm first
      .forEach((e) => {
        if (!keptIds.has(e.adId)) evict.push(e.adId);
      });
  }
  return evict;
}

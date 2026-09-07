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

export function selectEvictions(entries: any[], cap: number): string[] {
  const evict: string[] = [];
  const candidates: any[] = [];

  entries.forEach((e) => {
    if (e.state === 'rendered' || e.state === 'expired') { evict.push(e.adId); return; }
    // Reserved bids are neither counted nor evicted: trimming must never take a bid out from
    // under a pending render.
    if (e.state === 'reserved') return;
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

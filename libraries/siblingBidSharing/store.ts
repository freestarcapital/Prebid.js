export type BidState = 'available' | 'reserved' | 'rendered' | 'expired';
export type ReleaseReason = 'gam-loss' | 'refresh' | 'destroy' | 'timeout';
export type Channel = 'gam' | 'backfill';

export interface StoreEntry {
  adId: string;
  siblingGroupId: string;
  sourceAdUnitCode: string;
  expiresAt: number;
  state: BidState;
  reservedBy?: string;
  channel?: Channel;
  reservedAt?: number;
  renderedAt?: number;
  targetedAt?: number;
  lastReason?: ReleaseReason;
}

export class SiblingGroupStore {
  private entries = new Map<string, StoreEntry>();
  private byGroup = new Map<string, Set<string>>();

  deposit(e: Omit<StoreEntry, 'state'>): boolean {
    if (this.entries.has(e.adId)) return false;
    this.entries.set(e.adId, { ...e, state: 'available' });
    let group = this.byGroup.get(e.siblingGroupId);
    if (!group) { group = new Set(); this.byGroup.set(e.siblingGroupId, group); }
    group.add(e.adId);
    return true;
  }

  get(adId: string): StoreEntry | undefined { return this.entries.get(adId); }

  membersOf(siblingGroupId: string): StoreEntry[] {
    const ids = this.byGroup.get(siblingGroupId);
    if (!ids) return [];
    const out: StoreEntry[] = [];
    ids.forEach((id) => { const e = this.entries.get(id); if (e) out.push(e); });
    return out;
  }

  reserve(adId: string, destinationAdUnitCode: string, channel: Channel): boolean {
    const e = this.entries.get(adId);
    if (!e || e.state !== 'available') return false;
    e.state = 'reserved';
    e.reservedBy = destinationAdUnitCode;
    e.channel = channel;
    e.reservedAt = Date.now();
    // Survives the release: GAM keeps hb_adid on the slot long after the reservation lapses.
    if (channel === 'gam') e.targetedAt = Date.now();
    return true;
  }

  release(adId: string, reason: ReleaseReason): boolean {
    const e = this.entries.get(adId);
    if (!e || e.state !== 'reserved') return false;
    e.state = 'available';
    e.reservedBy = undefined;
    e.channel = undefined;
    e.reservedAt = undefined;
    e.lastReason = reason;
    return true;
  }

  consume(adId: string, destinationAdUnitCode: string): boolean {
    const e = this.entries.get(adId);
    if (!e || e.state === 'expired' || e.state === 'rendered') return false;
    if (e.state === 'reserved' && e.reservedBy !== destinationAdUnitCode) return false;
    e.state = 'rendered';
    e.reservedBy = destinationAdUnitCode;
    e.renderedAt = Date.now();
    return true;
  }

  remove(adId: string): boolean {
    const e = this.entries.get(adId);
    if (!e) return false;
    this.entries.delete(adId);
    const group = this.byGroup.get(e.siblingGroupId);
    if (group) {
      group.delete(adId);
      if (group.size === 0) this.byGroup.delete(e.siblingGroupId);
    }
    return true;
  }

  expire(adId: string): void {
    const e = this.entries.get(adId);
    if (!e || e.state === 'rendered') return;
    e.state = 'expired';
    e.reservedBy = undefined;
    e.channel = undefined;
  }

  releaseAllFor(destinationAdUnitCode: string, reason: ReleaseReason): string[] {
    const released: string[] = [];
    this.entries.forEach((e) => {
      if (e.state === 'reserved' && e.reservedBy === destinationAdUnitCode) {
        this.release(e.adId, reason);
        released.push(e.adId);
      }
    });
    return released;
  }

  claimable(siblingGroupId: string, now: number): StoreEntry[] {
    return this.membersOf(siblingGroupId).filter((e) => {
      if (e.state !== 'available') return false;
      // Swept on read rather than on a timer: a corpse must never be returned, and a
      // read-driven sweep costs nothing on groups nobody is claiming from.
      if (e.expiresAt <= now) { this.expire(e.adId); return false; }
      return true;
    });
  }

  snapshot() {
    const groups: Record<string, Record<BidState, number>> = {};
    this.entries.forEach((e) => {
      const g = (groups[e.siblingGroupId] ??= { available: 0, reserved: 0, rendered: 0, expired: 0 });
      g[e.state] += 1;
    });
    return { groups, total: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.byGroup.clear();
  }
}

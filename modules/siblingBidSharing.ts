import { config } from '../src/config.ts';
import { addApiMethod } from '../src/prebid.ts';
import { setupBeforeHookFnOnce } from '../src/hook.ts';
import { getHighestCpmBidsFromBidPool, targeting } from '../src/targeting.ts';
import { isBidUsable } from '../src/targeting/filters.ts';
import { SiblingGroupStore } from '../libraries/siblingBidSharing/store.ts';
import { isClaimable, resolveBidderCode, type RequestRegime } from '../libraries/siblingBidSharing/eligibility.ts';
import { capFor, selectEvictions } from '../libraries/siblingBidSharing/cap.ts';
import * as events from '../src/events.ts';
import { EVENTS } from '../src/constants.ts';
import { auctionManager } from '../src/auctionManager.js';
import { logInfo, logWarn } from '../src/utils.js';
import { getGlobal } from '../src/prebidGlobal.ts';
import { wrapInBids } from '../src/utils/wrapsInBids.ts';

export interface SiblingBidSharingConfig {
  enabled?: boolean;
}

declare module '../src/config' {
  interface Config {
    bidSharing?: SiblingBidSharingConfig;
  }
}

export const store = new SiblingGroupStore();

let active: Required<SiblingBidSharingConfig> = { enabled: false };

// `init: true` is mandatory. pubfig calls setConfig at src/pbjs/base.js:804, and a subscriber
// registered afterwards without it never sees the initial value.
config.getConfig(
  'bidSharing',
  (cfg) => {
    active = { enabled: cfg?.bidSharing?.enabled === true };
  },
  { init: true },
);

export function getActiveConfig() { return active; }

events.on(EVENTS.BID_RESPONSE, (bid: any) => {
  // The group and the regime are attached to the AD UNIT by pubfig's format_pbjs; a bidderRequest
  // never carries either.
  const adUnit: any = auctionManager.index.getAdUnit(bid);
  const siblingGroupId = bid?.siblingGroupId ?? adUnit?.siblingGroupId;
  if (!siblingGroupId || !bid?.adId) return;

  bid.siblingGroupId = siblingGroupId;
  bid.requestRegime = bid?.requestRegime ?? adUnit?.requestRegime;
  const deposited = store.deposit({
    adId: bid.adId,
    siblingGroupId,
    sourceAdUnitCode: bid.adUnitCode,
    expiresAt: Number(bid.responseTimestamp ?? Date.now()) + Number(bid.ttl ?? 0) * 1000,
  });
  if (deposited) {
    logInfo(`[siblingBidSharing] deposit adId=${bid.adId} group=${siblingGroupId} src=${bid.adUnitCode} bidder=${bid.bidderCode} cpm=${bid.cpm}`);
    scheduleSweep(siblingGroupId);
  }
});

function redistributeAcrossSiblings(
  fn: any, bidsReceived: any[], winReducer: any, adUnitBidLimit: any, hasModified: boolean, winSorter: any,
) {
  if (!active.enabled) return fn.call(this, bidsReceived, winReducer, adUnitBidLimit, hasModified, winSorter);

  const codesByGroup = new Map<string, Set<string>>();
  const regimeByCode = new Map<string, RequestRegime>();
  const addCode = (group: string, code: string, regime?: RequestRegime) => {
    let set = codesByGroup.get(group);
    if (!set) { set = new Set(); codesByGroup.set(group, set); }
    set.add(code);
    if (regime && !regimeByCode.has(code)) regimeByCode.set(code, regime);
  };

  // Destinations come from the ad units first, so a sibling with no bid of its own can still
  // receive one; the pool only widens that set.
  ((getGlobal().adUnits ?? []) as any[]).forEach((u: any) => {
    if (u?.code && u?.siblingGroupId) addCode(u.siblingGroupId, u.code, u.requestRegime);
  });
  bidsReceived.forEach((b: any) => {
    if (b?.siblingGroupId && !b.isSiblingFill) addCode(b.siblingGroupId, b.adUnitCode, b.requestRegime);
  });

  const seen = new Set<string>();
  const pool: any[] = [];
  const add = (b: any) => {
    const key = `${b.adId}|${b.adUnitCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(b);
  };

  bidsReceived.forEach((b: any) => {
    const entry = store.get(b?.adId);
    // A reserved bid is in the pool for its holder and for nobody else. The reservation already
    // cleared eligibility, so redirecting it onto the holder is not re-checked.
    if (entry?.state === 'reserved') {
      if (entry.reservedBy === b.adUnitCode) {
        add(b);
      } else if (entry.reservedBy != null && !b.isSiblingFill) {
        add({ ...b, adUnitCode: entry.reservedBy, sourceAdUnitCode: b.adUnitCode, isSiblingFill: true });
      }
      return;
    }
    add(b);
  });

  bidsReceived.forEach((b: any) => {
    if (!b?.siblingGroupId || b.isSiblingFill) return;
    const entry = store.get(b.adId);
    if (entry && entry.state !== 'available') return;
    const codes = codesByGroup.get(b.siblingGroupId);
    if (!codes) return;

    codes.forEach((code) => {
      if (code === b.adUnitCode) return;
      if (!isClaimable(b, code, active, b.siblingGroupId, regimeByCode.get(code)).ok) return;
      // A shallow clone, not a copy of state: the store stays authoritative and this object
      // exists only for core's per-bidder reduce.
      add({ ...b, adUnitCode: code, sourceAdUnitCode: b.adUnitCode, isSiblingFill: true });
    });
  });

  return fn.call(this, pool, winReducer, adUnitBidLimit, hasModified, winSorter);
}

setupBeforeHookFnOnce(getHighestCpmBidsFromBidPool, redistributeAcrossSiblings);

export const RESERVE_TIMEOUT_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearReleaseTimeout(adId: string) {
  clearTimeout(timers.get(adId));
  timers.delete(adId);
}

export function scheduleReleaseTimeout(adId: string) {
  clearReleaseTimeout(adId);
  timers.set(adId, setTimeout(() => {
    timers.delete(adId);
    if (store.release(adId, 'timeout')) {
      logWarn(`[siblingBidSharing] release adId=${adId} reason=timeout`);
    }
  }, RESERVE_TIMEOUT_MS));
}

export const SWEEP_DEBOUNCE_MS = 30;
export const SWEEP_MAX_WAIT_MS = 250;
const sweepTimers = new Map<string, { timer: any; firstQueuedAt: number }>();

export function sweepGroup(siblingGroupId: string) {
  if (!active.enabled) return;

  const entries = store.membersOf(siblingGroupId);
  const fromAdUnits = ((getGlobal().adUnits ?? []) as any[])
    .filter((u: any) => u?.siblingGroupId === siblingGroupId).length;
  // No ad unit registered (as in most tests): proxy live membership from outstanding entries.
  const liveMembers = fromAdUnits || new Set(
    entries.filter((e) => e.state === 'available' || e.state === 'reserved').map((e) => e.sourceAdUnitCode),
  ).size;
  const cap = capFor(liveMembers);

  const withCpm = entries.map((e) => ({
    ...e,
    cpm: auctionManager.findBidByAdId(e.adId)?.cpm ?? 0,
  }));

  selectEvictions(withCpm, cap).forEach((adId) => {
    const bid = auctionManager.findBidByAdId(adId);
    if (!bid) { store.remove(adId); return; }
    if (auctionManager.removeBid(bid)) {
      logInfo(`[siblingBidSharing] evict adId=${adId} group=${siblingGroupId} cap=${cap} members=${liveMembers}`);
      store.remove(adId);
    }
  });
}

export function scheduleSweep(siblingGroupId: string, fn = sweepGroup) {
  const now = Date.now();
  const pending = sweepTimers.get(siblingGroupId);
  const firstQueuedAt = pending?.firstQueuedAt ?? now;

  // maxWait: without it a deposit stream at scroll rate defers the sweep indefinitely.
  if (now - firstQueuedAt >= SWEEP_MAX_WAIT_MS) {
    clearTimeout(pending?.timer);
    sweepTimers.delete(siblingGroupId);
    fn(siblingGroupId);
    return;
  }

  clearTimeout(pending?.timer);
  sweepTimers.set(siblingGroupId, {
    firstQueuedAt,
    timer: setTimeout(() => { sweepTimers.delete(siblingGroupId); fn(siblingGroupId); }, SWEEP_DEBOUNCE_MS),
  });
}

function reserveFromTargeting(map: any) {
  Object.entries(map ?? {}).forEach(([code, kv]: [string, any]) => {
    const adId = kv?.hb_adid;
    if (typeof adId !== 'string' || !adId) return;
    if (store.reserve(adId, code, 'gam')) {
      scheduleReleaseTimeout(adId);
      const e = store.get(adId);
      logInfo(`[siblingBidSharing] claim granted adId=${adId} group=${e?.siblingGroupId} src=${e?.sourceAdUnitCode} dst=${code} channel=gam`);
    }
  });
}

// First-write-wins within one targeting pass, so one adId cannot be bound to two slots.
function reserveTargetedBids(fn: any, adUnit: any) {
  if (active.enabled) reserveFromTargeting(targeting.getAllTargeting(adUnit));
  return fn.call(this, adUnit);
}

setupBeforeHookFnOnce(targeting.setTargetingForGPT, reserveTargetedBids);

// The map core actually applied, which is recomputed after the pass above.
function reserveAppliedTargeting(fn: any, targetingSet: any) {
  if (active.enabled) reserveFromTargeting(targetingSet);
  return fn.call(this, targetingSet);
}

setupBeforeHookFnOnce(targeting.targetingDone, reserveAppliedTargeting);

events.on(EVENTS.BID_WON, (bid: any) => {
  if (!bid?.adId) return;
  clearReleaseTimeout(bid.adId);

  // Stamp attribution here rather than at either render site: this handler runs for BOTH
  // channels, and the store already knows the destination. `bid.adUnitCode` stays the source.
  const entry = store.get(bid.adId);
  const destination = entry?.reservedBy ?? bid.adUnitCode;
  if (entry) {
    bid.renderAdUnitCode = destination;
    bid.siblingGroupId = entry.siblingGroupId;
    bid.isSiblingFill = destination !== entry.sourceAdUnitCode;
  }

  if (store.consume(bid.adId, destination)) {
    logInfo(`[siblingBidSharing] consume adId=${bid.adId} src=${entry?.sourceAdUnitCode} dst=${destination}`);
  }
  if (entry) {
    scheduleSweep(entry.siblingGroupId);
  }
});

function getSiblingGroupState() {
  return { ...store.snapshot(), config: { ...active } };
}

declare module '../src/prebidGlobal' {
  interface PrebidJS {
    getSiblingGroupState: typeof getSiblingGroupState;
  }
}

addApiMethod('getSiblingGroupState', getSiblingGroupState, false);

// The destination's group and regime live on its ad unit (attached in format_pbjs).
function adUnitOf(adUnitCode: string): any {
  return (getGlobal().adUnits as any[])?.find((u: any) => u.code === adUnitCode);
}

function regimeOf(adUnitCode: string) {
  return adUnitOf(adUnitCode)?.requestRegime;
}

function groupOf(adUnitCode: string) {
  return adUnitOf(adUnitCode)?.siblingGroupId;
}

function getBids(adUnitCode: string) {
  const received: any[] = auctionManager.getBidsReceived();
  if (!active.enabled) {
    return wrapInBids(received.filter((b: any) => b.adUnitCode === adUnitCode && isBidUsable(b)));
  }

  const now = Date.now();

  // Drives the read-time expiry sweep. Without this nothing ever transitions to 'expired',
  // so R2's claim-time TTL enforcement would silently never happen — and with render-time
  // suppression deliberately off, this is the only place TTL is enforced at all.
  const groups = new Set<string>();
  received.forEach((b: any) => {
    const e = store.get(b.adId);
    if (e) groups.add(e.siblingGroupId);
  });
  groups.forEach((g) => store.claimable(g, now));

  const destinationGroup = groupOf(adUnitCode);
  const destinationRegime = regimeOf(adUnitCode);

  const all: any[] = received.filter((b: any) => {
    if (!isBidUsable(b)) return false;
    const e = store.get(b.adId);
    if (!e) return b.adUnitCode === adUnitCode;
    if (e.state === 'rendered' || e.state === 'expired') return false;
    if (e.state === 'reserved') return e.reservedBy === adUnitCode;
    return b.adUnitCode === adUnitCode ||
      isClaimable(b, adUnitCode, active, destinationGroup, destinationRegime).ok;
  });
  return wrapInBids(all);
}

function matchesSize(bid: any, sizes: any[]): boolean {
  return sizes.some((s: any) => Number(s?.[0]) === Number(bid.width) && Number(s?.[1]) === Number(bid.height));
}

function claimBid(adUnitCode: string, opts: any = {}) {
  const channel = opts.channel ?? 'backfill';
  const excludedAdIds: string[] = opts.exclude?.adIds ?? [];
  const excludedBidders: string[] = opts.exclude?.bidders ?? [];
  const sizes: any[] | null = Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : null;

  const eligible = getBids(adUnitCode).filter((b: any) => {
    if (excludedAdIds.includes(b.adId)) return false;
    if (excludedBidders.includes(resolveBidderCode(b))) return false;
    return sizes == null || matchesSize(b, sizes);
  });
  const candidates = eligible
    .filter((b: any) => (opts.floor == null ? true : Number(b.cpm) >= Number(opts.floor)))
    .sort((a: any, b: any) => Number(b.cpm) - Number(a.cpm));

  for (const bid of candidates) {
    const entry = store.get(bid.adId);
    // Ungrouped inventory and a disabled module both hand the bid back unreserved: there is no
    // store entry to reserve, or no sharing to protect.
    if (!active.enabled || entry == null) {
      logInfo(`[siblingBidSharing] claim granted adId=${bid.adId} dst=${adUnitCode} channel=${channel} store=${entry == null ? 'none' : 'disabled'}`);
      return bid;
    }
    if (store.reserve(bid.adId, adUnitCode, channel)) {
      scheduleReleaseTimeout(bid.adId);
      logInfo(`[siblingBidSharing] claim granted adId=${bid.adId} dst=${adUnitCode} channel=${channel} store=reserved`);
      return bid;
    }
  }

  const reason = candidates.length ? 'all-reserved' : (eligible.length ? 'below-floor' : 'no-candidates');
  logInfo(`[siblingBidSharing] claim denied dst=${adUnitCode} channel=${channel} reason=${reason}`);
  return null;
}

declare module '../src/prebidGlobal' {
  interface PrebidJS {
    getBids: typeof getBids;
    claimBid: typeof claimBid;
    release: (adId: string, reason: any) => boolean;
    consume: (adId: string, adUnitCode: string) => boolean;
  }
}

addApiMethod('getBids', getBids, false);
addApiMethod('claimBid', claimBid, false);
addApiMethod('release', (adId: string, reason: any) => {
  clearReleaseTimeout(adId);
  return store.release(adId, reason);
}, false);
addApiMethod('consume', (adId: string, code: string) => store.consume(adId, code), false);

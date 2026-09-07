import { config } from '../src/config.ts';
import { addApiMethod } from '../src/prebid.ts';
import { setupBeforeHookFnOnce } from '../src/hook.ts';
import { getHighestCpmBidsFromBidPool, targeting } from '../src/targeting.ts';
import { SiblingGroupStore } from '../libraries/siblingBidSharing/store.ts';
import { isClaimable, type RequestRegime } from '../libraries/siblingBidSharing/eligibility.ts';
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
  const req = auctionManager.index.getBidderRequest(bid);
  const siblingGroupId = bid?.siblingGroupId ?? req?.siblingGroupId;
  if (!siblingGroupId || !bid?.adId) return;

  bid.siblingGroupId = siblingGroupId;
  bid.requestRegime = bid?.requestRegime ?? req?.requestRegime;
  const deposited = store.deposit({
    adId: bid.adId,
    siblingGroupId,
    sourceAdUnitCode: bid.adUnitCode,
    expiresAt: Number(bid.responseTimestamp ?? Date.now()) + Number(bid.ttl ?? 0) * 1000,
  });
  if (deposited) {
    logInfo(`[siblingBidSharing] deposit adId=${bid.adId} group=${siblingGroupId} src=${bid.adUnitCode} bidder=${bid.bidderCode} cpm=${bid.cpm}`);
  }
});

function redistributeAcrossSiblings(
  fn: any, bidsReceived: any[], winReducer: any, adUnitBidLimit: any, hasModified: boolean, winSorter: any,
) {
  if (!active.enabled) return fn.call(this, bidsReceived, winReducer, adUnitBidLimit, hasModified, winSorter);

  const codesByGroup = new Map<string, Set<string>>();
  const regimeByCode = new Map<string, RequestRegime>();
  bidsReceived.forEach((b) => {
    if (!b?.siblingGroupId) return;
    let set = codesByGroup.get(b.siblingGroupId);
    if (!set) { set = new Set(); codesByGroup.set(b.siblingGroupId, set); }
    set.add(b.adUnitCode);
    if (b.requestRegime) regimeByCode.set(b.adUnitCode, b.requestRegime);
  });

  const pool = [...bidsReceived];
  bidsReceived.forEach((b) => {
    const codes = b?.siblingGroupId ? codesByGroup.get(b.siblingGroupId) : undefined;
    if (!codes) return;
    const entry = store.get(b.adId);
    if (entry && entry.state !== 'available') return;

    codes.forEach((code) => {
      if (code === b.adUnitCode) return;
      const verdict = isClaimable(b, code, active, b.siblingGroupId, regimeByCode.get(code));
      if (!verdict.ok) return;
      // A shallow clone, not a copy of state: the store stays authoritative and this object
      // exists only for core's per-bidder reduce.
      pool.push({ ...b, adUnitCode: code, sourceAdUnitCode: b.adUnitCode, isSiblingFill: true });
    });
  });

  return fn.call(this, pool, winReducer, adUnitBidLimit, true, winSorter);
}

setupBeforeHookFnOnce(getHighestCpmBidsFromBidPool, redistributeAcrossSiblings);

export const RESERVE_TIMEOUT_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleReleaseTimeout(adId: string) {
  clearTimeout(timers.get(adId));
  timers.set(adId, setTimeout(() => {
    timers.delete(adId);
    if (store.release(adId, 'timeout')) {
      logWarn(`[siblingBidSharing] release adId=${adId} reason=timeout`);
    }
  }, RESERVE_TIMEOUT_MS));
}

function reserveTargetedBids(fn: any, adUnit: any) {
  if (!active.enabled) return fn.call(this, adUnit);
  const map = targeting.getAllTargeting(adUnit);
  Object.entries(map ?? {}).forEach(([code, kv]: any) => {
    const adId = kv?.hb_adid;
    if (!adId) return;
    if (store.reserve(adId, code, 'gam')) {
      scheduleReleaseTimeout(adId);
      const e = store.get(adId);
      logInfo(`[siblingBidSharing] claim granted adId=${adId} group=${e?.siblingGroupId} src=${e?.sourceAdUnitCode} dst=${code} channel=gam`);
    }
  });
  return fn.call(this, adUnit);
}

setupBeforeHookFnOnce(targeting.setTargetingForGPT, reserveTargetedBids);

events.on(EVENTS.BID_WON, (bid: any) => {
  if (!bid?.adId) return;
  clearTimeout(timers.get(bid.adId));
  timers.delete(bid.adId);

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

// The destination's regime lives on its ad unit (attached in format_pbjs next to siblingGroupId).
function regimeOf(adUnitCode: string) {
  return (getGlobal().adUnits as any[])?.find((u: any) => u.code === adUnitCode)?.requestRegime;
}

function getBids(adUnitCode: string) {
  const now = Date.now();

  // Drives the read-time expiry sweep. Without this nothing ever transitions to 'expired',
  // so R2's claim-time TTL enforcement would silently never happen — and with render-time
  // suppression deliberately off, this is the only place TTL is enforced at all.
  const groups = new Set<string>();
  auctionManager.getBidsReceived().forEach((b: any) => {
    const e = store.get(b.adId);
    if (e) groups.add(e.siblingGroupId);
  });
  groups.forEach((g) => store.claimable(g, now));

  const all: any[] = auctionManager.getBidsReceived().filter((b: any) => {
    const e = store.get(b.adId);
    if (!e) return b.adUnitCode === adUnitCode;
    if (e.state === 'rendered' || e.state === 'expired') return false;
    if (e.state === 'reserved' && e.reservedBy !== adUnitCode) return false;
    return b.adUnitCode === adUnitCode ||
      isClaimable(b, adUnitCode, active, e.siblingGroupId, regimeOf(adUnitCode)).ok;
  });
  return wrapInBids(all);
}

function claimBid(adUnitCode: string, opts: any = {}) {
  const channel = opts.channel ?? 'backfill';
  const candidates = getBids(adUnitCode)
    .filter((b: any) => !(opts.exclude?.adIds ?? []).includes(b.adId))
    .filter((b: any) => !(opts.exclude?.bidders ?? []).includes(b.bidderCode))
    .filter((b: any) => (opts.floor == null ? true : Number(b.cpm) >= Number(opts.floor)))
    .sort((a: any, b: any) => Number(b.cpm) - Number(a.cpm));

  for (const bid of candidates) {
    if (store.reserve(bid.adId, adUnitCode, channel)) {
      scheduleReleaseTimeout(bid.adId);
      logInfo(`[siblingBidSharing] claim granted adId=${bid.adId} dst=${adUnitCode} channel=${channel}`);
      return bid;
    }
  }
  logInfo(`[siblingBidSharing] claim denied dst=${adUnitCode} channel=${channel} reason=${candidates.length ? 'all-reserved' : 'no-candidates'}`);
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
addApiMethod('release', (adId: string, reason: any) => store.release(adId, reason), false);
addApiMethod('consume', (adId: string, code: string) => store.consume(adId, code), false);

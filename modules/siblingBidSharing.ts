import { config } from '../src/config.ts';
import { addApiMethod } from '../src/prebid.ts';
import { setupBeforeHookFnOnce } from '../src/hook.ts';
import { getHighestCpmBidsFromBidPool } from '../src/targeting.ts';
import { SiblingGroupStore } from '../libraries/siblingBidSharing/store.ts';
import { isClaimable, type RequestRegime } from '../libraries/siblingBidSharing/eligibility.ts';
import * as events from '../src/events.ts';
import { EVENTS } from '../src/constants.ts';
import { auctionManager } from '../src/auctionManager.js';
import { logInfo } from '../src/utils.js';

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

function getSiblingGroupState() {
  return { ...store.snapshot(), config: { ...active } };
}

declare module '../src/prebidGlobal' {
  interface PrebidJS {
    getSiblingGroupState: typeof getSiblingGroupState;
  }
}

addApiMethod('getSiblingGroupState', getSiblingGroupState, false);

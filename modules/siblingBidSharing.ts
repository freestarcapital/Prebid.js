import { config } from '../src/config.ts';
import { addApiMethod } from '../src/prebid.ts';
import { SiblingGroupStore } from '../libraries/siblingBidSharing/store.ts';
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

function getSiblingGroupState() {
  return { ...store.snapshot(), config: { ...active } };
}

declare module '../src/prebidGlobal' {
  interface PrebidJS {
    getSiblingGroupState: typeof getSiblingGroupState;
  }
}

addApiMethod('getSiblingGroupState', getSiblingGroupState, false);

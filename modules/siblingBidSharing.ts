import { config } from '../src/config.ts';
import { addApiMethod } from '../src/prebid.ts';
import { SiblingGroupStore } from '../libraries/siblingBidSharing/store.ts';

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

function getSiblingGroupState() {
  return { ...store.snapshot(), config: { ...active } };
}

declare module '../src/prebidGlobal' {
  interface PrebidJS {
    getSiblingGroupState: typeof getSiblingGroupState;
  }
}

addApiMethod('getSiblingGroupState', getSiblingGroupState, false);

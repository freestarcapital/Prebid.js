import { expect } from 'chai';
import { config } from 'src/config.js';
import { getGlobal } from 'src/prebidGlobal.js';
import adapterManager from 'src/adapterManager.js';
import * as events from 'src/events.js';
import { EVENTS } from 'src/constants.js';
import { SiblingGroupStore } from 'libraries/siblingBidSharing/store.js';
import { auctionManager } from 'src/auctionManager.js';
import { store, scheduleReleaseTimeout, RESERVE_TIMEOUT_MS } from 'modules/siblingBidSharing.js';
import { isClaimable } from 'libraries/siblingBidSharing/eligibility.js';
import { getHighestCpmBidsFromBidPool, targeting } from 'src/targeting.js';
import { getHighestCpm } from 'src/utils/reducers.js';

describe('SiblingGroupStore', () => {
  let store;
  const entry = (adId, code = 'medrec1') => ({
    adId,
    siblingGroupId: 'medrec',
    sourceAdUnitCode: code,
    expiresAt: Date.now() + 300_000,
  });

  beforeEach(() => { store = new SiblingGroupStore(); });

  it('deposits as available', () => {
    store.deposit(entry('a1'));
    expect(store.get('a1').state).to.equal('available');
  });

  it('deposit returns true on the first deposit and false for a duplicate adId', () => {
    expect(store.deposit(entry('a1'))).to.equal(true);
    expect(store.deposit(entry('a1'))).to.equal(false);
  });

  it('reserves an available bid and records the holder and channel', () => {
    store.deposit(entry('a1'));
    expect(store.reserve('a1', 'medrec2', 'gam')).to.equal(true);
    const e = store.get('a1');
    expect(e.state).to.equal('reserved');
    expect(e.reservedBy).to.equal('medrec2');
    expect(e.channel).to.equal('gam');
  });

  it('refuses to reserve a bid another sibling already holds', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'gam');
    expect(store.reserve('a1', 'medrec3', 'backfill')).to.equal(false);
    expect(store.get('a1').reservedBy).to.equal('medrec2');
  });

  it('releases back to available with a reason', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'gam');
    expect(store.release('a1', 'gam-loss')).to.equal(true);
    const e = store.get('a1');
    expect(e.state).to.equal('available');
    expect(e.reservedBy).to.equal(undefined);
    expect(e.lastReason).to.equal('gam-loss');
  });

  it('consume is terminal and cannot be released', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'gam');
    store.consume('a1', 'medrec2');
    expect(store.get('a1').state).to.equal('rendered');
    expect(store.release('a1', 'refresh')).to.equal(false);
    expect(store.get('a1').state).to.equal('rendered');
  });

  it('expire is terminal and removes the bid from claimability', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'gam');
    store.expire('a1');
    expect(store.get('a1').state).to.equal('expired');
    expect(store.reserve('a1', 'medrec3', 'gam')).to.equal(false);
  });

  it('releaseAllFor releases every bid one unit holds and returns their ids', () => {
    store.deposit(entry('a1'));
    store.deposit(entry('a2'));
    store.deposit(entry('a3'));
    store.reserve('a1', 'medrec2', 'gam');
    store.reserve('a2', 'medrec2', 'gam');
    store.reserve('a3', 'medrec9', 'gam');

    expect(store.releaseAllFor('medrec2', 'destroy').sort()).to.deep.equal(['a1', 'a2']);
    expect(store.get('a1').state).to.equal('available');
    expect(store.get('a3').state).to.equal('reserved');
  });

  it('membersOf returns only the requested group', () => {
    store.deposit(entry('a1'));
    store.deposit({ ...entry('b1'), siblingGroupId: 'other' });
    expect(store.membersOf('medrec').map((e) => e.adId)).to.deep.equal(['a1']);
  });

  it('claimable excludes expired entries and sweeps them', () => {
    const now = Date.now();
    store.deposit({ adId: 'fresh', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: now + 1000 });
    store.deposit({ adId: 'stale', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: now - 1 });

    expect(store.claimable('g', now).map((e) => e.adId)).to.deep.equal(['fresh']);
    expect(store.get('stale').state).to.equal('expired');
  });

  it('claimable excludes reserved entries', () => {
    const now = Date.now();
    store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: now + 1000 });
    store.reserve('a1', 'u2', 'gam');
    expect(store.claimable('g', now)).to.deep.equal([]);
  });

  it('a released bid is re-checked for expiry before becoming claimable again', () => {
    const now = Date.now();
    store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: now + 50 });
    store.reserve('a1', 'u2', 'gam');
    store.release('a1', 'gam-loss');
    expect(store.claimable('g', now + 100)).to.deep.equal([]);
    expect(store.get('a1').state).to.equal('expired');
  });

  it('snapshot counts entries per group and per state', () => {
    store.deposit(entry('a1'));
    store.deposit(entry('a2'));
    store.deposit({ ...entry('b1'), siblingGroupId: 'other' });
    store.reserve('a1', 'medrec2', 'gam');
    store.consume('b1', 'other2');

    expect(store.snapshot()).to.deep.equal({
      groups: {
        medrec: { available: 1, reserved: 1, rendered: 0, expired: 0 },
        other: { available: 0, reserved: 0, rendered: 1, expired: 0 },
      },
      total: 3,
    });
  });

  it('consume from available without a prior reservation renders and records the destination', () => {
    store.deposit(entry('a1'));
    expect(store.consume('a1', 'medrec2')).to.equal(true);
    const e = store.get('a1');
    expect(e.state).to.equal('rendered');
    expect(e.reservedBy).to.equal('medrec2');
  });

  it('consume by a unit that does not hold the reservation is refused', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'gam');
    expect(store.consume('a1', 'medrec3')).to.equal(false);
    let e = store.get('a1');
    expect(e.state).to.equal('reserved');
    expect(e.reservedBy).to.equal('medrec2');

    expect(store.consume('a1', 'medrec2')).to.equal(true);
    e = store.get('a1');
    expect(e.state).to.equal('rendered');
    expect(e.reservedBy).to.equal('medrec2');
  });

  it('remove deletes the entry and its group membership', () => {
    store.deposit(entry('a1'));
    expect(store.remove('a1')).to.equal(true);
    expect(store.get('a1')).to.equal(undefined);
    expect(store.membersOf('medrec')).to.deep.equal([]);
    expect(store.remove('nope')).to.equal(false);
  });

  it('clear empties the store', () => {
    store.deposit(entry('a1'));
    store.deposit(entry('a2'));
    store.clear();
    expect(store.snapshot().total).to.equal(0);
    expect(store.get('a1')).to.equal(undefined);
  });
});

describe('siblingBidSharing module', () => {
  // Every bid handed to getBids/claimBid now runs through core's isBidUsable, which needs a
  // response timestamp and a ttl.
  const usable = (o = {}) => ({
    adId: 'a1',
    adUnitCode: 'medrec1',
    siblingGroupId: 'medrec',
    bidderCode: 'ix',
    adapterCode: 'ix',
    cpm: 2,
    requestRegime: 'eager',
    ttl: 300,
    responseTimestamp: Date.now(),
    adserverTargeting: {},
    ...o,
  });

  const enable = () => config.setConfig({ bidSharing: { enabled: true } });

  function useAdUnits(units) {
    const saved = getGlobal().adUnits;
    getGlobal().adUnits = units;
    return () => { getGlobal().adUnits = saved; };
  }

  beforeEach(() => { store.clear(); });
  afterEach(() => {
    config.resetConfig();
    store.clear();
  });

  it('registers itself as an installed module', () => {
    expect(getGlobal().installedModules).to.include('siblingBidSharing');
  });

  it('exposes a pure getSiblingGroupState read', () => {
    expect(typeof getGlobal().getSiblingGroupState).to.equal('function');
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 300_000 });
    store.deposit({ adId: 'a2', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 300_000 });
    store.reserve('a2', 'medrec2', 'gam');

    const result = getGlobal().getSiblingGroupState();
    expect(result.groups.medrec).to.deep.equal({ available: 1, reserved: 1, rendered: 0, expired: 0 });
    expect(result.total).to.equal(2);

    result.groups.medrec.available = 99;
    result.total = 99;

    const again = getGlobal().getSiblingGroupState();
    expect(again.groups.medrec).to.deep.equal({ available: 1, reserved: 1, rendered: 0, expired: 0 });
    expect(again.total).to.equal(2);
  });

  it('reads bidSharing config, defaulting to disabled', () => {
    expect(getGlobal().getSiblingGroupState().config).to.deep.equal({ enabled: false });
  });

  it('picks up config set before the module subscribed', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    expect(getGlobal().getSiblingGroupState().config.enabled).to.equal(true);
  });

  it('deposits a bid carrying a siblingGroupId, keyed by adId', () => {
    events.emit(EVENTS.BID_RESPONSE, {
      adId: 'a1',
      adUnitCode: 'medrec1',
      siblingGroupId: 'medrec',
      ttl: 300,
      responseTimestamp: Date.now(),
    });
    expect(store.get('a1').siblingGroupId).to.equal('medrec');
    expect(store.get('a1').state).to.equal('available');
  });

  it('falls back to the ad unit for the group and regime the bid does not carry', () => {
    const stub = sinon.stub(auctionManager.index, 'getAdUnit')
      .returns({ code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' });
    try {
      const bid = {
        adId: 'c1', adUnitCode: 'medrec1', adUnitId: 'au-1', ttl: 300, responseTimestamp: Date.now(),
      };
      events.emit(EVENTS.BID_RESPONSE, bid);
      expect(store.get('c1').siblingGroupId).to.equal('medrec');
      expect(bid.siblingGroupId).to.equal('medrec');
      expect(bid.requestRegime).to.equal('eager');
    } finally {
      stub.restore();
    }
  });

  it('ignores a bid with no siblingGroupId', () => {
    events.emit(EVENTS.BID_RESPONSE, { adId: 'a2', adUnitCode: 'x', ttl: 300 });
    expect(store.get('a2')).to.equal(undefined);
  });

  it('derives expiresAt from responseTimestamp and ttl', () => {
    const t = Date.now();
    events.emit(EVENTS.BID_RESPONSE, {
      adId: 'a3', adUnitCode: 'medrec1', siblingGroupId: 'medrec', ttl: 300, responseTimestamp: t,
    });
    expect(store.get('a3').expiresAt).to.equal(t + 300_000);
  });

  it('a duplicate BID_RESPONSE for the same adId leaves the original entry unchanged', () => {
    const t = Date.now();
    events.emit(EVENTS.BID_RESPONSE, {
      adId: 'a4', adUnitCode: 'medrec1', siblingGroupId: 'medrec', ttl: 300, responseTimestamp: t,
    });
    events.emit(EVENTS.BID_RESPONSE, {
      adId: 'a4', adUnitCode: 'medrec2', siblingGroupId: 'medrec', ttl: 600, responseTimestamp: t + 1000,
    });
    const e = store.get('a4');
    expect(e.sourceAdUnitCode).to.equal('medrec1');
    expect(e.expiresAt).to.equal(t + 300_000);
  });

  it('offers an eligible sibling bid to the other codes in its group', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec2', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'lazy' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);

    const clone = out.find((b) => b.adUnitCode === 'medrec2' && b.adId === 'a1');
    expect(clone).to.include({ sourceAdUnitCode: 'medrec1', isSiblingFill: true });
    expect(out.filter((b) => b.adUnitCode === 'medrec1' && b.adId === 'a2')).to.deep.equal([]);
  });

  it('does nothing when disabled', () => {
    config.setConfig({ bidSharing: { enabled: false } });
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec2', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'lazy' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    expect(out.length).to.equal(2);
    expect(out.some((b) => b.isSiblingFill)).to.equal(false);
  });

  it('offers a reserved bid to its holder and to nobody else', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec2', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'appnexus', adapterCode: 'appnexus', requestRegime: 'lazy' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    expect(out.filter((b) => b.adId === 'a1' && b.adUnitCode === 'medrec1')).to.deep.equal([]);
    expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2')).to.equal(true);
  });

  it('keeps a bid its own unit reserved and clones it nowhere', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec1', 'gam');
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec2', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'appnexus', adapterCode: 'appnexus', requestRegime: 'lazy' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec1')).to.equal(true);
    expect(out.filter((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2')).to.deep.equal([]);
  });

  it('leaves core to bucket the enlarged pool per ad unit and bidder', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    expect(out.filter((b) => b.adUnitCode === 'medrec1').map((b) => b.adId)).to.deep.equal(['a1']);
  });

  it('clones onto a sibling ad unit that has no bid of its own', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    try {
      const bids = [
        { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      ];
      const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
      expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2' && b.isSiblingFill)).to.equal(true);
    } finally {
      restoreUnits();
    }
  });

  it('is idempotent when its own output is fed back in', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    const key = (b) => `${b.adId}|${b.adUnitCode}`;
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      { adId: 'a2', adUnitCode: 'medrec2', siblingGroupId: 'medrec', cpm: 1, bidderCode: 'appnexus', adapterCode: 'appnexus', requestRegime: 'lazy' },
    ];
    const first = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    const second = getHighestCpmBidsFromBidPool(first, getHighestCpm, undefined, false);
    expect(second.length).to.equal(first.length);
    expect(second.map(key).sort()).to.deep.equal(first.map(key).sort());
  });

  it('reserves the bid bound to each slot at targeting time', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    // Reserving here also schedules a real release timer; run under a fake clock so it
    // never escapes into the runner as a live native timeout.
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      sinon.stub(targeting, 'getAllTargeting').returns({ u2: { hb_adid: 'a1' } });
      window.googletag = { pubads: () => ({ getSlots: () => [] }) };
      targeting.setTargetingForGPT();
      expect(store.get('a1').state).to.equal('reserved');
      expect(store.get('a1').reservedBy).to.equal('u2');
    } finally {
      clock.restore();
      targeting.getAllTargeting.restore();
      delete window.googletag;
    }
  });

  it('reserves from the targeting map core actually applied', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      targeting.targetingDone({ u2: { hb_adid: 'a1' } });
      expect(store.get('a1').state).to.equal('reserved');
      expect(store.get('a1').reservedBy).to.equal('u2');
    } finally {
      clock.restore();
    }
  });

  it('leaves a bid another unit already holds alone when core applies its targeting', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      store.reserve('a1', 'u2', 'gam');
      targeting.targetingDone({ u3: { hb_adid: 'a1' } });
      expect(store.get('a1').reservedBy).to.equal('u2');
    } finally {
      clock.restore();
    }
  });

  it('auto-releases a reservation that never rendered, after the timeout', () => {
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      store.reserve('a1', 'u2', 'gam');
      scheduleReleaseTimeout('a1');
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('available');
      expect(store.get('a1').lastReason).to.equal('timeout');
    } finally {
      clock.restore();
    }
  });

  it('does not release a bid that rendered before the timeout', () => {
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      store.reserve('a1', 'u2', 'gam');
      scheduleReleaseTimeout('a1');
      store.consume('a1', 'u2');
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('rendered');
    } finally {
      clock.restore();
    }
  });

  it('getBids returns the dual shape wrapInBids produces', () => {
    const r = getGlobal().getBids('medrec1');
    expect(Array.isArray(r)).to.equal(true);
    expect(r.bids).to.equal(r);
  });

  it('getBids shows a unit the bid it reserved itself', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec1', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: 2, requestRegime: 'eager' },
    ]);
    try {
      expect(getGlobal().getBids('medrec1').some((b) => b.adId === 'a1')).to.equal(true);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids hides a bid reserved by a different sibling', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: 2, requestRegime: 'eager' },
    ]);
    try {
      expect(getGlobal().getBids('medrec1').some((b) => b.adId === 'a1')).to.equal(false);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids does not reserve anything', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: 2, requestRegime: 'eager' },
    ]);
    try {
      getGlobal().getBids('medrec1');
      expect(store.get('a1').state).to.equal('available');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids expires a lapsed bid on read', () => {
    store.deposit({ adId: 'old', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() - 1 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'old', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: 2, requestRegime: 'eager' },
    ]);
    try {
      getGlobal().getBids('medrec1');
      expect(store.get('old').state).to.equal('expired');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid returns null rather than throwing when another sibling won the race', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: 2, requestRegime: 'eager' },
    ]);
    try {
      expect(getGlobal().claimBid('medrec3', { channel: 'backfill' })).to.equal(null);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid compares string floors numerically, not lexicographically', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', bidderCode: 'ix', adapterCode: 'ix', cpm: '9.50', requestRegime: 'eager' },
    ]);
    try {
      expect(getGlobal().claimBid('medrec1', { floor: '10.00' })).to.equal(null);
      expect(getGlobal().claimBid('medrec1', { floor: '9.00' })).to.have.property('adId', 'a1');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });
  it('binds a shared bid to one slot only, through the real targeting path', () => {
    config.setConfig({ bidSharing: { enabled: true }, useBidCache: true });
    const clock = sinon.useFakeTimers();
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      usable({ adserverTargeting: { hb_adid: 'a1', hb_pb: '2.00', hb_bidder: 'ix' } }),
    ]);
    window.googletag = { pubads: () => ({ getSlots: () => [] }) };
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
      targeting.setTargetingForGPT(['medrec1', 'medrec2']);

      const entry = store.get('a1');
      expect(entry.state).to.equal('reserved');
      expect(['medrec1', 'medrec2']).to.include(entry.reservedBy);

      const other = entry.reservedBy === 'medrec1' ? 'medrec2' : 'medrec1';
      const map = targeting.getAllTargeting(['medrec1', 'medrec2']);
      expect(map[entry.reservedBy].hb_adid).to.equal('a1');
      expect(map[other].hb_adid).to.equal(undefined);
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
      clock.restore();
      delete window.googletag;
    }
  });
});

describe('isClaimable', () => {
  const cfg = { enabled: true };
  const bid = (o = {}) => ({
    adUnitCode: 'medrec1',
    siblingGroupId: 'medrec',
    bidderCode: 'appnexus',
    adapterCode: 'appnexus',
    source: 'client',
    requestRegime: 'eager',
    ...o,
  });

  it('allows a bid on its own unit even when the bidder is denylisted', () => {
    expect(isClaimable(bid({ bidderCode: 'teads', adapterCode: 'teads' }), 'medrec1', cfg).ok)
      .to.equal(true);
  });

  it('denies a denylisted bidder cross-unit', () => {
    expect(isClaimable(bid({ bidderCode: 'teads', adapterCode: 'teads' }), 'medrec2', cfg).reason)
      .to.equal('denylisted');
    expect(isClaimable(bid({ bidderCode: 'kargo', adapterCode: 'kargo' }), 'medrec2', cfg).reason)
      .to.equal('denylisted');
  });

  it('allows a bidder that is not on the list', () => {
    expect(isClaimable(bid(), 'medrec2', cfg, 'medrec').ok).to.equal(true);
  });

  it('matches unaliased, so the aliased client leg is not missed', () => {
    const aliased = bid({ bidderCode: 'kargoFsClientAux', adapterCode: 'kargo' });
    expect(isClaimable(aliased, 'medrec2', cfg, 'medrec').reason).to.equal('denylisted');
  });

  it('consults the alias registry, not just adapterCode', () => {
    adapterManager.aliasRegistry['teadsAlias'] = 'teads';
    try {
      const aliased = bid({ bidderCode: 'teadsAlias', adapterCode: undefined });
      expect(isClaimable(aliased, 'medrec2', cfg, 'medrec').reason).to.equal('denylisted');
    } finally {
      delete adapterManager.aliasRegistry['teadsAlias'];
    }
  });

  it('prefers adapterCode over bidderCode', () => {
    const aliased = bid({ bidderCode: 'somethingElse', adapterCode: 'teads' });
    expect(isClaimable(aliased, 'medrec2', cfg, 'medrec').reason).to.equal('denylisted');
  });

  it('fails closed when alias resolution throws', () => {
    const stub = sinon.stub(adapterManager, 'resolveAlias').throws(new Error('boom'));
    try {
      expect(isClaimable(bid(), 'medrec2', cfg, 'medrec').reason).to.equal('denylisted');
    } finally {
      stub.restore();
    }
  });

  it('denies cross-unit reuse when sharing is disabled', () => {
    expect(isClaimable(bid(), 'medrec2', { enabled: false }, 'medrec').reason).to.equal('disabled');
    expect(isClaimable(bid(), 'medrec1', { enabled: false }, 'medrec').ok).to.equal(true);
  });

  it('denies deal bids cross-unit', () => {
    expect(isClaimable(bid({ dealId: 'PMP-1' }), 'medrec2', cfg).reason).to.equal('deal-excluded');
  });

  it('denies a bid from another group', () => {
    expect(isClaimable(bid({ siblingGroupId: 'other' }), 'medrec2', cfg, 'medrec').reason)
      .to.equal('wrong-group');
  });

  it('allows an eager bid on a lazy destination', () => {
    expect(isClaimable(bid(), 'medrec2', cfg, 'medrec', 'lazy').ok).to.equal(true);
  });

  it('allows a lazy bid on a lazy destination', () => {
    expect(isClaimable(bid({ requestRegime: 'lazy' }), 'medrec2', cfg, 'medrec', 'lazy').ok)
      .to.equal(true);
  });

  it('denies a lazy bid on an eager destination', () => {
    expect(isClaimable(bid({ requestRegime: 'lazy' }), 'medrec2', cfg, 'medrec', 'eager').reason)
      .to.equal('regime');
  });

  it('treats a missing regime conservatively on both sides', () => {
    expect(isClaimable(bid({ requestRegime: undefined }), 'medrec2', cfg, 'medrec', 'eager').reason)
      .to.equal('regime');
    expect(isClaimable(bid({ requestRegime: 'lazy' }), 'medrec2', cfg, 'medrec', undefined).reason)
      .to.equal('regime');
  });

  it('never applies the regime clause to a bid on its own unit', () => {
    expect(isClaimable(bid({ requestRegime: 'lazy' }), 'medrec1', cfg, 'medrec', 'eager').ok)
      .to.equal(true);
  });
});

import { expect } from 'chai';
import { config } from 'src/config.js';
import { getGlobal } from 'src/prebidGlobal.js';
import adapterManager from 'src/adapterManager.js';
import * as events from 'src/events.js';
import * as utils from 'src/utils.js';
import { BID_STATUS, EVENTS } from 'src/constants.js';
import { SiblingGroupStore } from 'libraries/siblingBidSharing/store.js';
import { auctionManager } from 'src/auctionManager.js';
import {
  store, scheduleReleaseTimeout, RESERVE_TIMEOUT_MS, GAM_RESERVE_TIMEOUT_MS, sweepGroup, scheduleSweep, cancelScheduledSweeps,
  SWEEP_DEBOUNCE_MS, SWEEP_MAX_WAIT_MS,
} from 'modules/siblingBidSharing.js';
import { isClaimable } from 'libraries/siblingBidSharing/eligibility.js';
import { getHighestCpmBidsFromBidPool, targeting } from 'src/targeting.js';
import { getHighestCpm } from 'src/utils/reducers.js';
import {
  capFor, perUnitFor, selectEvictions, RENDERED_GRACE_MS, TARGETED_GRACE_MS,
} from 'libraries/siblingBidSharing/cap.js';

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

  it('consume stamps the render time', () => {
    store.deposit(entry('a1'));
    const before = Date.now();
    store.consume('a1', 'medrec2');
    expect(store.get('a1').renderedAt).to.be.at.least(before);
  });

  it('records the targeting time for a gam reservation and keeps it across a release', () => {
    store.deposit(entry('a1'));
    const before = Date.now();
    store.reserve('a1', 'medrec2', 'gam');
    const targetedAt = store.get('a1').targetedAt;
    expect(targetedAt).to.be.at.least(before);
    store.release('a1', 'timeout');
    expect(store.get('a1').targetedAt).to.equal(targetedAt);
  });

  it('does not record a targeting time for a backfill reservation', () => {
    store.deposit(entry('a1'));
    store.reserve('a1', 'medrec2', 'backfill');
    expect(store.get('a1').targetedAt).to.equal(undefined);
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

  // The shape pubfig writes: a flat per-ad-unit-code floor map.
  const setFloors = (values) => config.setConfig({
    floors: { data: { currency: 'USD', schema: { fields: ['adUnitCode'] }, values } },
  });

  function useAdUnits(units) {
    const saved = getGlobal().adUnits;
    getGlobal().adUnits = units;
    return () => { getGlobal().adUnits = saved; };
  }

  beforeEach(() => { store.clear(); });
  afterEach(() => {
    config.resetConfig();
    store.clear();
    cancelScheduledSweeps();
  });

  it('registers itself as an installed module', () => {
    expect(getGlobal().installedModules).to.include('siblingBidSharing');
  });

  it('exposes a pure getSiblingGroupState read', () => {
    expect(typeof getGlobal().getSiblingGroupState).to.equal('function');
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 300_000 });
    store.deposit({ adId: 'a2', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 300_000 });
    store.reserve('a2', 'medrec2', 'gam');

    const expected = {
      available: 1, reserved: 1, rendered: 0, expired: 0, members: [], liveMembers: 1, cap: null,
    };
    const result = getGlobal().getSiblingGroupState();
    expect(result.groups.medrec).to.deep.equal(expected);
    expect(result.total).to.equal(2);

    result.groups.medrec.available = 99;
    result.total = 99;

    const again = getGlobal().getSiblingGroupState();
    expect(again.groups.medrec).to.deep.equal(expected);
    expect(again.total).to.equal(2);
  });

  it('reports group members, live count, and cap from registered ad units', () => {
    const restoreUnits = useAdUnits([
      { code: 'medrec2', siblingGroupId: 'medrec' },
      { code: 'medrec1', siblingGroupId: 'medrec' },
    ]);
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 300_000 });
      const group = getGlobal().getSiblingGroupState().groups.medrec;
      expect(group.members).to.deep.equal(['medrec1', 'medrec2']);
      expect(group.liveMembers).to.equal(2);
      expect(group.cap).to.equal(8);
    } finally {
      restoreUnits();
    }
  });

  it('reports cap: null for a single-member group', () => {
    const restoreUnits = useAdUnits([
      { code: 'solo1', siblingGroupId: 'solo' },
    ]);
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'solo', sourceAdUnitCode: 'solo1', expiresAt: Date.now() + 300_000 });
      const group = getGlobal().getSiblingGroupState().groups.solo;
      expect(group.liveMembers).to.equal(1);
      expect(group.cap).to.equal(null);
    } finally {
      restoreUnits();
    }
  });

  it('lists a group with registered ad units but no store entries, at zero counts', () => {
    const restoreUnits = useAdUnits([
      { code: 'empty2', siblingGroupId: 'empty' },
      { code: 'empty1', siblingGroupId: 'empty' },
    ]);
    try {
      const group = getGlobal().getSiblingGroupState().groups.empty;
      expect(group).to.deep.equal({
        available: 0, reserved: 0, rendered: 0, expired: 0, members: ['empty1', 'empty2'], liveMembers: 2, cap: 8,
      });
    } finally {
      restoreUnits();
    }
  });

  it('reads bidSharing config, defaulting to disabled', () => {
    expect(getGlobal().getSiblingGroupState().config).to.deep.equal({ enabled: false });
  });

  it('picks up config set before the module subscribed', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    expect(getGlobal().getSiblingGroupState().config.enabled).to.equal(true);
  });

  it('deposits a bid carrying a siblingGroupId, keyed by adId', () => {
    enable();
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
    enable();
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
    enable();
    events.emit(EVENTS.BID_RESPONSE, { adId: 'a2', adUnitCode: 'x', ttl: 300 });
    expect(store.get('a2')).to.equal(undefined);
  });

  it('derives expiresAt from responseTimestamp and ttl', () => {
    enable();
    const t = Date.now();
    events.emit(EVENTS.BID_RESPONSE, {
      adId: 'a3', adUnitCode: 'medrec1', siblingGroupId: 'medrec', ttl: 300, responseTimestamp: t,
    });
    expect(store.get('a3').expiresAt).to.equal(t + 300_000);
  });

  it('a duplicate BID_RESPONSE for the same adId leaves the original entry unchanged', () => {
    enable();
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

  it('does not clone a bid that misses the destination unit floor', () => {
    enable();
    setFloors({ medrec1: 10, medrec2: 2 });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    try {
      const bids = [
        { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 1.5, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      ];
      const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
      expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2')).to.equal(false);
      // its own unit's floor is not a claim-time gate on its own bid
      expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec1')).to.equal(true);
    } finally {
      restoreUnits();
    }
  });

  it('clones a bid that clears the destination unit floor', () => {
    enable();
    setFloors({ medrec2: 2 });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    try {
      const bids = [
        { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 2.5, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
      ];
      const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
      expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2' && b.isSiblingFill)).to.equal(true);
    } finally {
      restoreUnits();
    }
  });

  it('keeps a held bid in its holder pool even below the holder floor', () => {
    enable();
    setFloors({ medrec2: 10 });
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    const bids = [
      { adId: 'a1', adUnitCode: 'medrec1', siblingGroupId: 'medrec', cpm: 1.5, bidderCode: 'ix', adapterCode: 'ix', requestRegime: 'eager' },
    ];
    const out = getHighestCpmBidsFromBidPool(bids, getHighestCpm, undefined, false);
    expect(out.some((b) => b.adId === 'a1' && b.adUnitCode === 'medrec2')).to.equal(true);
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

  it('reserves from a prefixed ad id targeting key', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      targeting.targetingDone({ u2: { fs_adid: 'a1', fs_bidder: 'ix' } });
      expect(store.get('a1').state).to.equal('reserved');
      expect(store.get('a1').reservedBy).to.equal('u2');
    } finally {
      clock.restore();
    }
  });

  it('ignores send-all-bids ad id keys', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      targeting.targetingDone({ u2: { hb_adid_ix: 'a1' } });
      expect(store.get('a1').state).to.equal('available');
    } finally {
      clock.restore();
    }
  });

  it('ignores an ad id targeting value the store does not know', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      expect(() => targeting.targetingDone({ u2: { hb_adid: 'nosuchbid' } })).to.not.throw();
      expect(store.get('nosuchbid')).to.equal(undefined);
      expect(store.get('a1').state).to.equal('available');
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

  it('holds a targeting reservation past the backfill timeout and releases it at the GAM timeout', () => {
    enable();
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 600_000 });
      targeting.targetingDone({ u2: { hb_adid: 'a1' } });
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('reserved');
      clock.tick(GAM_RESERVE_TIMEOUT_MS - RESERVE_TIMEOUT_MS);
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
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec1', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().getBids('medrec1').some((b) => b.adId === 'a1')).to.equal(true);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids hides a bid reserved by a different sibling', () => {
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().getBids('medrec1').some((b) => b.adId === 'a1')).to.equal(false);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids does not reserve anything', () => {
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      getGlobal().getBids('medrec1');
      expect(store.get('a1').state).to.equal('available');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids expires a lapsed bid on read', () => {
    enable();
    store.deposit({ adId: 'old', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() - 1 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ adId: 'old' })]);
    try {
      getGlobal().getBids('medrec1');
      expect(store.get('old').state).to.equal('expired');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids drops a bid core would not consider usable', () => {
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ status: BID_STATUS.RENDERED })]);
    try {
      expect(getGlobal().getBids('medrec1').length).to.equal(0);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('getBids gates a sibling bid on the destination unit group, not the bid own group', () => {
    enable();
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
      { code: 'leader1', siblingGroupId: 'leader', requestRegime: 'eager' },
    ]);
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.deposit({ adId: 'l1', siblingGroupId: 'leader', sourceAdUnitCode: 'leader1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      usable(),
      usable({ adId: 'l1', adUnitCode: 'leader1', siblingGroupId: 'leader' }),
    ]);
    try {
      const ids = getGlobal().getBids('medrec2').map((b) => b.adId);
      expect(ids).to.include('a1');
      expect(ids).to.not.include('l1');
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
    }
  });

  it('getBids hides a sibling bid when sharing is disabled', () => {
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().getBids('medrec2').length).to.equal(0);
      expect(getGlobal().getBids('medrec1').map((b) => b.adId)).to.deep.equal(['a1']);
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
    }
  });

  it('claimBid returns null rather than throwing when another sibling won the race', () => {
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().claimBid('medrec3', { channel: 'backfill' })).to.equal(null);
      expect(store.get('a1').reservedBy).to.equal('medrec2');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid grants the bid back to the unit already holding it', () => {
    const clock = sinon.useFakeTimers();
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec1', 'gam');
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().claimBid('medrec1', { channel: 'backfill' })).to.have.property('adId', 'a1');
      const e = store.get('a1');
      expect(e.state).to.equal('reserved');
      expect(e.reservedBy).to.equal('medrec1');

      // the hold is re-armed rather than left on the original timer, and keeps the GAM duration
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('reserved');
      clock.tick(GAM_RESERVE_TIMEOUT_MS - RESERVE_TIMEOUT_MS);
      expect(store.get('a1').state).to.equal('available');
    } finally {
      auctionManager.getBidsReceived.restore();
      clock.restore();
    }
  });

  it('releases a backfill claim after the backfill timeout', () => {
    const clock = sinon.useFakeTimers();
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 600_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().claimBid('medrec1', { channel: 'backfill' })).to.have.property('adId', 'a1');
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('available');
      expect(store.get('a1').lastReason).to.equal('timeout');
    } finally {
      auctionManager.getBidsReceived.restore();
      clock.restore();
    }
  });

  it('claimBid compares string floors numerically, not lexicographically', () => {
    const clock = sinon.useFakeTimers();
    enable();
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: '9.50' })]);
    try {
      expect(getGlobal().claimBid('medrec1', { floor: '10.00' })).to.equal(null);
      expect(getGlobal().claimBid('medrec1', { floor: '9.00' })).to.have.property('adId', 'a1');
    } finally {
      auctionManager.getBidsReceived.restore();
      clock.restore();
    }
  });

  it('claimBid returns a bid that has no store entry without reserving it', () => {
    enable();
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ adId: 'n1', siblingGroupId: undefined })]);
    try {
      expect(getGlobal().claimBid('medrec1')).to.have.property('adId', 'n1');
      expect(store.get('n1')).to.equal(undefined);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid resolves an excluded bidder through the alias registry', () => {
    enable();
    adapterManager.aliasRegistry['ixFsClientAux'] = 'ix';
    sinon.stub(auctionManager, 'getBidsReceived').returns([
      usable({ bidderCode: 'ixFsClientAux', adapterCode: undefined }),
    ]);
    try {
      expect(getGlobal().claimBid('medrec1', { exclude: { bidders: ['ix'] } })).to.equal(null);
    } finally {
      auctionManager.getBidsReceived.restore();
      delete adapterManager.aliasRegistry['ixFsClientAux'];
    }
  });

  it('claimBid keeps only bids matching a requested size', () => {
    enable();
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ width: 300, height: 250 })]);
    try {
      expect(getGlobal().claimBid('medrec1', { sizes: [[728, 90]] })).to.equal(null);
      expect(getGlobal().claimBid('medrec1', { sizes: [[300, 250]] })).to.have.property('adId', 'a1');
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid returns the own-unit bid without reserving when sharing is disabled', () => {
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable()]);
    try {
      expect(getGlobal().claimBid('medrec1')).to.have.property('adId', 'a1');
      expect(store.get('a1').state).to.equal('available');
      expect(store.get('a1').reservedBy).to.equal(undefined);
    } finally {
      auctionManager.getBidsReceived.restore();
    }
  });

  it('claimBid reports below-floor separately from no-candidates', () => {
    enable();
    const logInfo = sinon.stub(utils, 'logInfo');
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 1 })]);
    try {
      getGlobal().claimBid('medrec1', { floor: 5 });
      expect(logInfo.getCalls().some((c) => String(c.args[0]).includes('reason=below-floor'))).to.equal(true);
      logInfo.resetHistory();
      getGlobal().claimBid('other1');
      expect(logInfo.getCalls().some((c) => String(c.args[0]).includes('reason=no-candidates'))).to.equal(true);
    } finally {
      auctionManager.getBidsReceived.restore();
      logInfo.restore();
    }
  });

  it('claimBid denies a cross-unit bid that misses the destination floor', () => {
    enable();
    setFloors({ medrec2: 2 });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    const logInfo = sinon.stub(utils, 'logInfo');
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 1.5 })]);
    try {
      expect(getGlobal().claimBid('medrec2', { channel: 'backfill' })).to.equal(null);
      expect(logInfo.getCalls().some((c) => String(c.args[0]).includes('reason=below-floor'))).to.equal(true);
      expect(store.get('a1').state).to.equal('available');
    } finally {
      auctionManager.getBidsReceived.restore();
      logInfo.restore();
      restoreUnits();
    }
  });

  it('claimBid grants a cross-unit bid that clears the destination floor', () => {
    const clock = sinon.useFakeTimers();
    enable();
    setFloors({ medrec2: 2 });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 2.5 })]);
    try {
      expect(getGlobal().claimBid('medrec2', { channel: 'backfill' })).to.have.property('adId', 'a1');
      expect(store.get('a1').reservedBy).to.equal('medrec2');
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
      clock.restore();
    }
  });

  it('claimBid still returns an own-unit bid priced under its own unit floor', () => {
    const clock = sinon.useFakeTimers();
    enable();
    setFloors({ medrec1: 10 });
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 2 })]);
    try {
      expect(getGlobal().claimBid('medrec1', { channel: 'backfill' })).to.have.property('adId', 'a1');
    } finally {
      auctionManager.getBidsReceived.restore();
      clock.restore();
    }
  });

  ['n/a', '', null, 0].forEach((value) => {
    it(`claimBid applies no gate for a destination floor of ${JSON.stringify(value)}`, () => {
      const clock = sinon.useFakeTimers();
      enable();
      setFloors({ medrec2: value });
      const restoreUnits = useAdUnits([
        { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
        { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
      ]);
      store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
      sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 0.1 })]);
      try {
        expect(getGlobal().claimBid('medrec2', { channel: 'backfill' })).to.have.property('adId', 'a1');
      } finally {
        auctionManager.getBidsReceived.restore();
        restoreUnits();
        clock.restore();
      }
    });
  });

  it('claimBid reads a destination floor written under a lower-cased key', () => {
    enable();
    setFloors({ medrec2: 2 });
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'MedRec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 1.5 })]);
    try {
      expect(getGlobal().claimBid('MedRec2', { channel: 'backfill' })).to.equal(null);
      expect(store.get('a1').state).to.equal('available');
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
    }
  });

  it('claimBid grants the holder a bid the destination floor rose above during the hold', () => {
    const clock = sinon.useFakeTimers();
    enable();
    const restoreUnits = useAdUnits([
      { code: 'medrec1', siblingGroupId: 'medrec', requestRegime: 'eager' },
      { code: 'medrec2', siblingGroupId: 'medrec', requestRegime: 'lazy' },
    ]);
    store.deposit({ adId: 'a1', siblingGroupId: 'medrec', sourceAdUnitCode: 'medrec1', expiresAt: Date.now() + 60_000 });
    store.reserve('a1', 'medrec2', 'gam');
    setFloors({ medrec2: 2.0 });
    sinon.stub(auctionManager, 'getBidsReceived').returns([usable({ cpm: 1.8 })]);
    try {
      expect(getGlobal().claimBid('medrec2', { channel: 'backfill' })).to.have.property('adId', 'a1');
      const e = store.get('a1');
      expect(e.state).to.equal('reserved');
      expect(e.reservedBy).to.equal('medrec2');
    } finally {
      auctionManager.getBidsReceived.restore();
      restoreUnits();
      clock.restore();
    }
  });

  it('release clears the pending auto-release timer', () => {
    const clock = sinon.useFakeTimers();
    try {
      store.deposit({ adId: 'a1', siblingGroupId: 'g', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      store.reserve('a1', 'u2', 'gam');
      scheduleReleaseTimeout('a1');
      expect(getGlobal().release('a1', 'gam-loss')).to.equal(true);
      store.reserve('a1', 'u3', 'gam');
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('a1').state).to.equal('reserved');
      expect(store.get('a1').reservedBy).to.equal('u3');
    } finally {
      clock.restore();
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

  it('evicts past the cap and calls through to auctionManager.removeBid', () => {
    enable();
    const removed = [];
    sinon.stub(auctionManager, 'removeBid').callsFake((b) => { removed.push(b.adId); return true; });
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      // 2 members, cap = 8; deposit 10 available bids
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `a${i}`, siblingGroupId: 'g', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g');
      expect(removed.length).to.equal(2);
      expect(removed.sort()).to.deep.equal(['a0', 'a1']);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('fires even under a continuous deposit stream, via maxWait', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const spy = sinon.spy();
    for (let i = 0; i < 50; i++) { scheduleSweep('g', spy); clock.tick(10); }
    expect(spy.called).to.equal(true); // a plain debounce would still be waiting
    clock.restore();
  });

  it('does nothing for a single-member group', () => {
    enable();
    const removed = [];
    sinon.stub(auctionManager, 'removeBid').callsFake((b) => { removed.push(b.adId); return true; });
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `s${i}`, siblingGroupId: 'solo', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('solo');
      expect(removed).to.deep.equal([]);
    } finally {
      auctionManager.removeBid.restore();
    }
  });

  it('removes evicted adIds from the store, so a swept sweep does not re-select them', () => {
    enable();
    sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `c${i}`, siblingGroupId: 'g2', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g2');
      const remainingIds = store.membersOf('g2').map((e) => e.adId);
      expect(remainingIds).to.not.include('c0');
      expect(remainingIds).to.not.include('c1');
      expect(remainingIds.length).to.equal(8);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('drops a store entry without calling removeBid when Prebid no longer knows the bid', () => {
    enable();
    const removeBid = sinon.stub(auctionManager, 'removeBid');
    sinon.stub(auctionManager, 'findBidByAdId').returns(undefined);
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `d${i}`, siblingGroupId: 'g3', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g3');
      expect(removeBid.called).to.equal(false);
      expect(store.membersOf('g3').length).to.equal(8);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('counts live membership from getGlobal().adUnits when it is non-zero, before falling back to the proxy', () => {
    enable();
    const restoreUnits = useAdUnits([
      { code: 'u1', siblingGroupId: 'g4' },
      { code: 'u2', siblingGroupId: 'g4' },
      { code: 'u3', siblingGroupId: 'g4' },
    ]);
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: 1 }));
    try {
      // 10 available bids from 2 source codes; 3 live ad units -> cap = 12, nothing evicted.
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `e${i}`, siblingGroupId: 'g4', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g4');
      expect(removeBid.called).to.equal(false);
      expect(store.membersOf('g4').length).to.equal(10);
    } finally {
      restoreUnits();
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('deposits nothing and schedules no sweep when sharing is disabled', () => {
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid');
    try {
      events.emit(EVENTS.BID_RESPONSE, {
        adId: 'f1', adUnitCode: 'medrec1', siblingGroupId: 'g5', ttl: 300, responseTimestamp: Date.now(),
      });
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.called).to.equal(false);
      expect(store.get('f1')).to.equal(undefined);
    } finally {
      removeBid.restore();
      clock.restore();
    }
  });

  it('schedules a sweep on an enabled deposit', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: 1 }));
    try {
      for (let i = 0; i < 9; i++) {
        store.deposit({ adId: `k${i}`, siblingGroupId: 'g7', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      events.emit(EVENTS.BID_RESPONSE, {
        adId: 'k9', adUnitCode: 'u1', siblingGroupId: 'g7', ttl: 300, responseTimestamp: Date.now(),
      });
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.called).to.equal(true);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('sweepGroup is a no-op when sharing is disabled', () => {
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: 1 }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `n${i}`, siblingGroupId: 'g8', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g8');
      expect(removeBid.called).to.equal(false);
      expect(store.membersOf('g8').length).to.equal(10);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('leaves a reserved entry in place when the group is swept', () => {
    enable();
    const removed = [];
    sinon.stub(auctionManager, 'removeBid').callsFake((b) => { removed.push(b.adId); return true; });
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `p${i}`, siblingGroupId: 'g9', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      // p0 is the lowest cpm, so the trim would take it first if reservations were counted.
      store.reserve('p0', 'u3', 'backfill');
      sweepGroup('g9');
      expect(removed).to.deep.equal(['p1']);
      expect(store.get('p0').state).to.equal('reserved');
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('collapses repeated scheduleSweep calls inside the debounce window into one sweep', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const spy = sinon.spy();
    try {
      for (let i = 0; i < 5; i++) { scheduleSweep('g', spy); clock.tick(SWEEP_DEBOUNCE_MS - 1); }
      clock.tick(SWEEP_DEBOUNCE_MS + 1);
      expect(spy.calledOnce).to.equal(true);
    } finally {
      clock.restore();
    }
  });

  it('cancelScheduledSweeps cancels a pending sweep', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const spy = sinon.spy();
    try {
      scheduleSweep('g', spy);
      cancelScheduledSweeps();
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(spy.called).to.equal(false);
    } finally {
      clock.restore();
    }
  });

  it('evicts a TTL-expired entry that nothing has read since it lapsed', () => {
    enable();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: 1 }));
    try {
      store.deposit({ adId: 'x1', siblingGroupId: 'gx', sourceAdUnitCode: 'u1', expiresAt: Date.now() - 1 });
      sweepGroup('gx');
      expect(removeBid.calledOnce).to.equal(true);
      expect(store.get('x1')).to.equal(undefined);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
    }
  });

  it('keeps a bid the creative can still resolve by adId right after BID_WON', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId')
      .callsFake((adId) => (store.get(adId) ? { adId, cpm: 1 } : undefined));
    try {
      store.deposit({ adId: 'w1', siblingGroupId: 'gw', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      store.deposit({ adId: 'w2', siblingGroupId: 'gw', sourceAdUnitCode: 'u2', expiresAt: Date.now() + 60_000 });
      events.emit(EVENTS.BID_WON, { adId: 'w1', adUnitCode: 'u1' });
      clock.tick(SWEEP_MAX_WAIT_MS + 1);

      expect(removeBid.called).to.equal(false);
      expect(auctionManager.findBidByAdId('w1')).to.not.equal(undefined);
      expect(store.get('w1').state).to.equal('rendered');
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('evicts the rendered bid once the render grace has passed, even in a quiescent group', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: 1 }));
    try {
      store.deposit({ adId: 'w1', siblingGroupId: 'gw', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      events.emit(EVENTS.BID_WON, { adId: 'w1', adUnitCode: 'u1' });
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.called).to.equal(false);

      clock.tick(RENDERED_GRACE_MS + SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.calledOnce).to.equal(true);
      expect(store.get('w1')).to.equal(undefined);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('keeps a gam-targeted bid out of the cpm trim until the targeting grace passes', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removed = [];
    sinon.stub(auctionManager, 'removeBid').callsFake((b) => { removed.push(b.adId); return true; });
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: adId === 't1' ? 0 : 5 }));
    try {
      // 2 source units -> cap 8. Nine entries, of which t1 is the cheapest.
      store.deposit({ adId: 't1', siblingGroupId: 'gt', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      for (let i = 0; i < 8; i++) {
        store.deposit({ adId: `q${i}`, siblingGroupId: 'gt', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      store.reserve('t1', 'u2', 'gam');
      scheduleReleaseTimeout('t1');
      clock.tick(RESERVE_TIMEOUT_MS + 1);
      expect(store.get('t1').state).to.equal('available');

      sweepGroup('gt');
      expect(removed).to.deep.equal([]);

      clock.tick(TARGETED_GRACE_MS);
      sweepGroup('gt');
      expect(removed).to.deep.equal(['t1']);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('gives a backfill reservation no trim exemption once it is released', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removed = [];
    sinon.stub(auctionManager, 'removeBid').callsFake((b) => { removed.push(b.adId); return true; });
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: adId === 'b1' ? 0 : 5 }));
    try {
      store.deposit({ adId: 'b1', siblingGroupId: 'gb', sourceAdUnitCode: 'u1', expiresAt: Date.now() + 60_000 });
      for (let i = 0; i < 8; i++) {
        store.deposit({ adId: `y${i}`, siblingGroupId: 'gb', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      store.reserve('b1', 'u2', 'backfill');
      scheduleReleaseTimeout('b1');
      clock.tick(RESERVE_TIMEOUT_MS + 1);

      sweepGroup('gb');
      expect(removed).to.deep.equal(['b1']);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('exposes sweepSiblingGroup so a host can trigger a sweep', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `m${i}`, siblingGroupId: 'gm', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      getGlobal().sweepSiblingGroup('gm');
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.callCount).to.equal(2);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('release schedules a sweep of the group it freed', () => {
    enable();
    const clock = sinon.useFakeTimers();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(true);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `v${i}`, siblingGroupId: 'gv', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      store.reserve('v0', 'u3', 'backfill');
      expect(getGlobal().release('v0', 'gam-loss')).to.equal(true);
      clock.tick(SWEEP_MAX_WAIT_MS + 1);
      expect(removeBid.callCount).to.equal(2);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
      clock.restore();
    }
  });

  it('leaves the entry in the store when removeBid refuses to remove a bid that still exists', () => {
    enable();
    const removeBid = sinon.stub(auctionManager, 'removeBid').returns(false);
    sinon.stub(auctionManager, 'findBidByAdId').callsFake((adId) => ({ adId, cpm: Number(adId.slice(1)) }));
    try {
      for (let i = 0; i < 10; i++) {
        store.deposit({ adId: `g${i}`, siblingGroupId: 'g6', sourceAdUnitCode: i % 2 ? 'u1' : 'u2', expiresAt: Date.now() + 60_000 });
      }
      sweepGroup('g6');
      expect(removeBid.called).to.equal(true);
      expect(store.membersOf('g6').length).to.equal(10);
    } finally {
      auctionManager.removeBid.restore();
      auctionManager.findBidByAdId.restore();
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

describe('retention cap', () => {
  const NOW = 1_700_000_000_000;
  // The old assertions describe behaviour with no grace at all.
  const evictNow = (entries, cap) => selectEvictions(entries, cap, NOW, 0, 0);

  it('steps perUnit by live group size', () => {
    expect(perUnitFor(2)).to.equal(4);
    expect(perUnitFor(20)).to.equal(4);
    expect(perUnitFor(21)).to.equal(3);
    expect(perUnitFor(40)).to.equal(3);
    expect(perUnitFor(41)).to.equal(2);
    expect(perUnitFor(70)).to.equal(2);
  });

  it('never drops below 2, so starvation is impossible at any size', () => {
    [1, 50, 500, 5000].forEach((n) => expect(perUnitFor(n)).to.be.at.least(2));
  });

  it('does not apply to single-member groups', () => {
    expect(capFor(1)).to.equal(Infinity);
  });

  it('computes keep as members x perUnit', () => {
    expect(capFor(10)).to.equal(40);
    expect(capFor(15)).to.equal(60);
    expect(capFor(70)).to.equal(140);
  });

  it('leaves at least one spare candidate per member at every step boundary', () => {
    [2, 20, 21, 40, 41, 70].forEach((n) => expect(capFor(n) - n).to.be.at.least(n));
  });

  it('always evicts rendered bids regardless of the cap', () => {
    const entries = [
      { adId: 'r1', state: 'rendered', cpm: 9 },
      { adId: 'a1', state: 'available', cpm: 1 },
    ];
    expect(evictNow(entries, 10)).to.deep.equal(['r1']);
  });

  it('never evicts or counts reserved bids', () => {
    const entries = [
      { adId: 'res', state: 'reserved', cpm: 0.1 },
      { adId: 'a1', state: 'available', cpm: 5 },
      { adId: 'a2', state: 'available', cpm: 4 },
    ];
    expect(evictNow(entries, 1)).to.deep.equal(['a2']);
  });

  it('evicts lowest cpm first', () => {
    const entries = [
      { adId: 'lo', state: 'available', cpm: 1 },
      { adId: 'mid', state: 'available', cpm: 5 },
      { adId: 'hi', state: 'available', cpm: 9 },
    ];
    expect(evictNow(entries, 1)).to.deep.equal(['lo', 'mid']);
  });

  it('coerces string cpm before ordering', () => {
    const entries = [
      { adId: 'a', state: 'available', cpm: '9.50' },
      { adId: 'b', state: 'available', cpm: '10.00' },
    ];
    expect(evictNow(entries, 1)).to.deep.equal(['a']);
  });

  it('always evicts expired bids, grace or not', () => {
    const entries = [{ adId: 'x1', state: 'expired', cpm: 9, renderedAt: NOW }];
    expect(selectEvictions(entries, 10, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['x1']);
  });

  it('keeps a rendered bid inside the render grace, and neither counts it', () => {
    const entries = [
      { adId: 'r1', state: 'rendered', cpm: 9, renderedAt: NOW - 1000 },
      { adId: 'a1', state: 'available', cpm: 1 },
    ];
    expect(selectEvictions(entries, 1, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal([]);
  });

  it('evicts a rendered bid once the render grace has passed', () => {
    const entries = [{ adId: 'r1', state: 'rendered', cpm: 9, renderedAt: NOW - RENDERED_GRACE_MS }];
    expect(selectEvictions(entries, 10, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['r1']);
  });

  it('evicts a rendered bid that carries no renderedAt', () => {
    const entries = [{ adId: 'r1', state: 'rendered', cpm: 9 }];
    expect(selectEvictions(entries, 10, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['r1']);
  });

  it('exempts a recently targeted bid from the cpm trim without counting it', () => {
    const entries = [
      { adId: 't1', state: 'available', cpm: 0.1, targetedAt: NOW - 1000 },
      { adId: 'a1', state: 'available', cpm: 5 },
      { adId: 'a2', state: 'available', cpm: 4 },
    ];
    expect(selectEvictions(entries, 1, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['a2']);
  });

  it('trims a targeted bid once its targeting grace has passed', () => {
    const entries = [
      { adId: 't1', state: 'available', cpm: 0.1, targetedAt: NOW - TARGETED_GRACE_MS },
      { adId: 'a1', state: 'available', cpm: 5 },
    ];
    expect(selectEvictions(entries, 1, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['t1']);
  });

  it('still expires a targeted bid inside its grace', () => {
    const entries = [{ adId: 't1', state: 'expired', cpm: 0.1, targetedAt: NOW - 1000 }];
    expect(selectEvictions(entries, 10, NOW, RENDERED_GRACE_MS, TARGETED_GRACE_MS)).to.deep.equal(['t1']);
  });
});

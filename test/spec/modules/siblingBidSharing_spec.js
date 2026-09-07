import { expect } from 'chai';
import { config } from 'src/config.js';
import { getGlobal } from 'src/prebidGlobal.js';
import adapterManager from 'src/adapterManager.js';
import * as events from 'src/events.js';
import { EVENTS } from 'src/constants.js';
import { SiblingGroupStore } from 'libraries/siblingBidSharing/store.js';
import { store } from 'modules/siblingBidSharing.js';
import { isClaimable } from 'libraries/siblingBidSharing/eligibility.js';

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

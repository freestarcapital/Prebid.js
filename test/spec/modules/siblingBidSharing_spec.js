import { expect } from 'chai';
import { config } from 'src/config.js';
import { getGlobal } from 'src/prebidGlobal.js';
import { SiblingGroupStore } from 'libraries/siblingBidSharing/store.js';
import 'modules/siblingBidSharing.js';

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
});

describe('siblingBidSharing module', () => {
  afterEach(() => { config.resetConfig(); });

  it('registers itself as an installed module', () => {
    expect(getGlobal().installedModules).to.include('siblingBidSharing');
  });

  it('exposes a pure getSiblingGroupState read', () => {
    expect(typeof getGlobal().getSiblingGroupState).to.equal('function');
    const before = getGlobal().getSiblingGroupState();
    getGlobal().getSiblingGroupState();
    expect(getGlobal().getSiblingGroupState()).to.deep.equal(before);
  });

  it('reads bidSharing config, defaulting to disabled', () => {
    expect(getGlobal().getSiblingGroupState().config).to.deep.equal({ enabled: false });
  });

  it('picks up config set before the module subscribed', () => {
    config.setConfig({ bidSharing: { enabled: true } });
    expect(getGlobal().getSiblingGroupState().config.enabled).to.equal(true);
  });
});

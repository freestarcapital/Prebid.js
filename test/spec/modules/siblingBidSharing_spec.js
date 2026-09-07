import { expect } from 'chai';
import { SiblingGroupStore } from 'libraries/siblingBidSharing/store.js';

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
});

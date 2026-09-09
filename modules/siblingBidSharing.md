# Sibling Bid Sharing

## Overview

Sibling bid sharing lets child ad units of a single placement share bid responses: a bid deposited
by one unit can be claimed by a sibling ad unit in the same group instead of going unused when its
own unit does not render it.

Prebid's own bid cache (`auctionManager`) stays the authoritative store of bid data. This module's
store (`libraries/siblingBidSharing/store.ts`) does not duplicate bid content — it holds only the
`adId`, group membership, and a small state machine (`available` / `reserved` / `rendered` /
`expired`) per bid, and resolves the bid itself from `auctionManager.findBidByAdId` on every read.

## Ad unit fields

The host sets two fields on the ad unit object; neither is read from the bidder response or the
bid request.

| Field | Type | Meaning |
|---|---|---|
| `siblingGroupId` | `string` | The group key. Bids from ad units sharing a `siblingGroupId` are eligible to be shared among the members of that group. |
| `requestRegime` | `'eager' \| 'lazy'` | Which pass requested the unit. A bid may travel eager → lazy, or within one regime; it never travels lazy → eager. |

Missing values fail closed: a bid with no `requestRegime` is treated as `lazy` (it can reach only
lazy destinations), and a destination with none is treated as `eager` (it accepts only eager bids). A missing
`siblingGroupId` on either side simply excludes that bid or unit from sharing.

## Configuration

```javascript
pbjs.setConfig({
  bidSharing: {
    enabled: true,               // defaults to false
    denylist: ['kargo', 'teads'] // bidder codes never shared cross-unit; defaults to []
  }
});
```

`denylist` holds unaliased bidder codes whose creatives do not survive being moved between slots
(outstream players, bidders with their own renderer). The module ships no codes of its own, so the
host owns the list and can change it without a Prebid build. A non-array value is treated as empty.

The config is read with `init: true`, so the value in effect at the first `setConfig` call after
module load applies immediately.

When `enabled` is `false` (the default), the module is inert: `BID_RESPONSE` deposits nothing, the
`getHighestCpmBidsFromBidPool` hook calls through with the pool unchanged (no cross-unit cloning),
the `setTargetingForGPT` / `targetingDone` reservation hooks reserve nothing, and sweeps are
no-ops. The public API still works, but only over each unit's own bids: `getBids` returns the
caller's own usable bids, and `claimBid` returns the highest-CPM own-unit candidate unreserved
(there is nothing in the store to reserve).

## How a claim happens

### GAM

1. `BID_RESPONSE` deposits the bid into the store under its `siblingGroupId`.
2. Before `getHighestCpmBidsFromBidPool` runs, a hook clones each eligible deposited bid onto every
   sibling ad unit code in its group, so GAM line-item targeting can consider it for any member.
3. Reservation happens twice — a pre-pass hook on `setTargetingForGPT` (before GPT's own key-value
   read), and again on `targetingDone` against the map core actually applied. First write wins, so
   one `adId` cannot end up reserved for two slots in the same pass. The ad id is read from
   whichever targeting key ends with `adid` (`hb_adid`, or `fs_adid` and any other prefix the
   publisher configures through `bidderSettings`), skipping send-all-bids keys such as
   `hb_adid_<bidder>` and values the store does not know.
4. A reservation is a hold, not a commit: once it is granted, if still unconsumed it is released
   back to `available` — after `GAM_RESERVE_TIMEOUT_MS` (10000ms) for a `gam` reservation, which
   has to outlast GAM's own response latency, and after `RESERVE_TIMEOUT_MS` (2000ms) for a
   `backfill` one.
5. `BID_WON` consumes the reservation and stamps the bid with `renderAdUnitCode` (the destination),
   `siblingGroupId`, and `isSiblingFill` (`true` when the destination differs from the originating
   unit). `adUnitCode` stays unchanged — it always identifies the unit the bid was requested for.

### Backfill

A destination unit that did not receive its own bid can call `pbjs.claimBid(adUnitCode, opts)`
directly; it reserves the bid the same way, under the `RESERVE_TIMEOUT_MS` backstop and `BID_WON`
consumption. A bid the calling unit already holds — the usual case once GAM targeting has reserved
each slot's own ad id — is granted straight back to it with its release timeout re-armed for the
duration of the channel it is held on, rather than released and reserved again, which would expose
it to the siblings mid-call.

### Eligibility

A candidate bid is claimable by a destination ad unit when all of the following hold: same
`siblingGroupId` as the destination; no `dealId`; bidder not on the configured `denylist`,
matched on the unaliased `adapterCode ?? bidderCode`; the eager/lazy regime rule is satisfied; not
currently reserved by a different ad unit; not expired or already rendered; passes core's own
`isBidUsable` filter. A bid destined for the unit it was originally requested for is never gated by
any of this — that case is not cross-unit reuse.

A cross-unit candidate must also clear the destination unit's floor. It is read on every claim, in
both channels, from Prebid's own `floors` config at `floors.data.values[<adUnitCode>]` — the flat
per-ad-unit-code map the host rewrites before each auction. A single pool pass reads each unit's
floor once, and nothing is cached beyond that pass.
Siblings carry different floors, so a bid priced against its source unit's floor is not offered to a
sibling whose floor is higher. Own-unit candidates are unaffected: they were already floored when
they were requested. A missing or non-numeric value applies no gate, and `opts.floor` on `claimBid`
stays an explicit caller override applied to every candidate. Only floors set through
`setConfig({ floors: { data: { values } } })` are read — the data a `floorProvider` endpoint fetches
is not. A bid the destination already holds is not re-gated by this floor: its reservation already
cleared eligibility, so a floor raised during the hold cannot strand it.

## Public API

| Method | Description |
|---|---|
| `pbjs.getBids(adUnitCode)` | Pure read. Returns an array (also exposed as `.bids` on itself) of usable bids available to `adUnitCode` — its own bids plus any sibling bids currently claimable by it. Reserves nothing. |
| `pbjs.claimBid(adUnitCode, { sizes, floor, channel, exclude: { adIds, bidders } })` | Reserves and returns the highest-CPM eligible bid, or `null` if none qualifies. `sizes` restricts to matching dimensions, `floor` to a minimum CPM, `exclude.adIds` / `exclude.bidders` drop specific bids or bidders, `channel` labels the reservation (defaults to `'backfill'`). A bid with no store entry — ungrouped inventory, or the module disabled — is returned without being reserved. |
| `pbjs.release(adId, reason)` | Releases a reservation back to `available` and schedules a sweep of its group. Returns `false` if the bid was not reserved. |
| `pbjs.consume(adId, adUnitCode)` | Marks `adId` rendered for `adUnitCode`. Returns `false` if the bid is expired, already rendered, or reserved by a different unit. |
| `pbjs.sweepSiblingGroup(siblingGroupId)` | Schedules an immediate sweep of one group. |
| `pbjs.getSiblingGroupState()` | Returns per-group counts by state, each group's `members` (registered ad unit codes), `liveMembers` (live member count), and `cap` (`null` when uncapped), plus the total entry count and the active `bidSharing` config. |

## Retention cap

`sweepGroup` trims each group's deposited bids. It is scheduled (debounced 30ms, with a 250ms max
wait so a steady deposit stream cannot defer it indefinitely) on deposit, on `BID_WON`, on
`release`, and on `sweepSiblingGroup`.

The cap is `members × perUnit(members)`, where `perUnit` is 4 for groups up to 20 live members, 3
up to 40, and 2 above that. A single-member group is uncapped — nothing is shared within it, so
nothing needs trimming.

Within a sweep: expired entries are always evicted; reserved entries are never evicted or counted
against the cap; a rendered entry is evicted once `RENDERED_GRACE_MS` (5000ms) has passed, because
`BID_WON` fires before the creative resolves and renders its bid by `adId`; a bid targeted through
the GAM channel is exempt from the CPM-based trim for `TARGETED_GRACE_MS` (30000ms), since GAM
keeps `hb_adid` on the slot after the reservation itself has lapsed; the remaining candidates are
sorted by CPM and the lowest-CPM entries beyond the cap are evicted.

Eviction removes the bid from Prebid's own cache via `auctionManager.removeBid` (a thin wrapper
over the auction's `removeBidReceived`, added to core for this purpose) and removes the store
entry. The cap should not be enabled on a site whose bid pool floor is off — that is a host-side
configuration concern, not something this module enforces.

## Build

The module is not built in by default and must be named explicitly (`gulp build
--modules=siblingBidSharing,...`). A bare `gulp build` with no `--modules` flag includes it, since
that form pulls in every module. The core edit this module depends on
(`auction.removeBidReceived`, `auctionManager.removeBid`) is always present in core and does
nothing unless this module is also built in.

## Logging

All log lines are prefixed `[siblingBidSharing]` and mark state transitions only: deposit, claim
granted, claim denied, release, consume, evict, and prune (a store entry whose bid is no longer in
`auctionManager` at sweep time). `claim denied` is logged only from `claimBid` (the backfill
channel) and carries one of three reasons: `no-candidates` (nothing in the group was eligible at
all), `below-floor` (eligible bids existed but none met `opts.floor` or the destination unit's
floor), or `all-reserved` (bids passed the floor but every one was already reserved by the time
this call tried to reserve it).

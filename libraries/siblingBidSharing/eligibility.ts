import adapterManager from '../../src/adapterManager.js';

export type DenyReason = 'denylisted' | 'deal-excluded' | 'wrong-group' | 'regime';
export type RequestRegime = 'eager' | 'lazy';
export interface Verdict { ok: boolean; reason?: DenyReason }

interface Cfg { enabled: boolean }

/**
 * Creative-portability exclusions, not commercial ones: teads is outstream video and kargo ships
 * its own renderer, so neither survives being moved between slots. Interim — replaced by the
 * per-network `isBidSharingEligible` flag when that ships.
 */
export const BID_SHARING_DENYLIST = ['kargo', 'teads'];

export function isDenylisted(bid: any): boolean {
  // adapterCode first, and unaliased: pubfig aliases the concurrent client leg (*FsClientAux),
  // so a raw-string check silently misses the aliased adapter.
  const key = adapterManager.resolveAlias(bid?.adapterCode ?? bid?.bidderCode ?? '');
  return BID_SHARING_DENYLIST.includes(key);
}

export function isClaimable(
  bid: any, destinationAdUnitCode: string, cfg: Cfg, siblingGroupId?: string,
  destinationRegime?: RequestRegime,
): Verdict {
  // A bid serving the unit it was requested for is not cross-unit reuse and is never gated.
  if (bid?.adUnitCode === destinationAdUnitCode) return { ok: true };

  if (siblingGroupId != null && bid?.siblingGroupId !== siblingGroupId) {
    return { ok: false, reason: 'wrong-group' };
  }
  if (bid?.dealId) return { ok: false, reason: 'deal-excluded' };
  if (isDenylisted(bid)) return { ok: false, reason: 'denylisted' };
  if (!regimeAllows(bid?.requestRegime, destinationRegime)) return { ok: false, reason: 'regime' };

  return { ok: true };
}

// Eager → lazy and same-regime travel only. A missing value resolves to the side that admits
// less, so a lost marker narrows sharing instead of leaking lazy-priced bids onto eager units.
function regimeAllows(source?: RequestRegime, destination?: RequestRegime): boolean {
  return (source ?? 'lazy') === 'eager' || (destination ?? 'eager') === 'lazy';
}

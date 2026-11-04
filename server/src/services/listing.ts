// One place that decides "is this item unlisted on Target?" and "may the hub send to this SKU?".
// Target keeps several versions of an item. An item counts as UNLISTED when its current (selling) version or its
// latest version is unlisted (or, without those flags, its newest version is).
// (Reading only the latest version missed unlisted items whose newer update was pending/rejected, so the hub
// thought they were listed and sent updates that put them on sale again.)

export function effectiveListing(prod: any): string | null {
  const st: any[] = prod?.product_statuses ?? [];
  if (!st.length) return null;
  const ver = (s: any) => Number(s?.version ?? 0);
  if (st.some((s) => s.listing_status === 'UNLISTED' && (s.current || s.latest))) return 'UNLISTED';
  // no current/latest flags: the newest version decides (a newer version after an unlist = listed again on purpose)
  const newest = [...st].sort((a, b) => ver(b) - ver(a))[0];
  if (!st.some((s) => s.current || s.latest) && newest?.listing_status === 'UNLISTED') return 'UNLISTED';
  const latest = st.find((s) => s.latest) ?? st.find((s) => s.current) ?? [...st].sort((a, b) => ver(b) - ver(a))[0];
  return latest?.listing_status ?? null;
}

/**
 * Send switch per SKU: OFF when unlisted on Target (always), otherwise your ON/OFF, otherwise ON.
 * OFF = the hub sends no content, images or price to that SKU, and stock 0.
 */
export function sendEnabled(v: { overrides: any; listingStatus: string | null }) {
  // unlisted on Target always wins, even over a Send ON: any update would put the size on sale again
  if (v?.listingStatus === 'UNLISTED') return false;
  const s = (v?.overrides as any)?._send;
  if (s === true || s === false) return s;
  return true;
}

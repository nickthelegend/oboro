import { inr, plan, priceLabel, tint, zecOf, type RelayPackage } from './relay';

export function GiftCard({ id, name, value, currency, zats }: { id: string; name: string; value: string; currency: string; zats?: number }) {
  const [a, b] = tint(id);
  return (
    <div className="gc" style={{ ['--a' as string]: a, ['--b' as string]: b }} role="img" aria-label={`${name} gift card, ${inr(value, currency)}`}>
      <div className="gc-top">
        <div>
          <div className="gc-name">{name.replace(/ India$/, '')}</div>
          <div className="gc-sub">Gift card · India</div>
        </div>
        <div className="gc-chip" aria-hidden="true" />
      </div>
      <div className="gc-val">{inr(value, currency)}</div>
      {zats ? <div className="gc-zec mono">{zecOf(zats)} ZEC</div> : null}
    </div>
  );
}

// A prepaid recharge has no card and no code: the face shows the operator and the picked plan instead.
export function RechargeFace({ id, name, pkg, currency }: { id: string; name: string; pkg?: RelayPackage; currency: string }) {
  const [a, b] = tint(id);
  const p = pkg ? plan(pkg.value) : undefined;
  return (
    <div className="gc rf" style={{ ['--a' as string]: a, ['--b' as string]: b }} role="img" aria-label={`${name} prepaid recharge${pkg ? `, ${pkg.value}` : ''}`}>
      <div className="gc-top">
        <div>
          <div className="gc-name">{name}</div>
          <div className="gc-sub">Prepaid recharge · India</div>
        </div>
        <svg className="rf-sig" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M3 18h2v3H3zM8 14h2v7H8zM13 10h2v11h-2zM18 5h2v16h-2z" fill="currentColor" />
        </svg>
      </div>
      <div className="gc-val">{pkg ? priceLabel(pkg, currency) : 'Pick a plan'}</div>
      <div className="gc-zec mono">{p ? `${p.data}${p.days ? ` · ${p.days} days` : ''}` : 'Delivered to the number, no code'}</div>
    </div>
  );
}

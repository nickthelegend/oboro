import { inr, tint, zecOf } from './relay';

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

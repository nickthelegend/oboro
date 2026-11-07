import { createPaywall } from './paywall.js';

export function createGateway(options: Parameters<typeof createPaywall>[0]) {
  const paywall = createPaywall(options);
  return { ...paywall, price: paywall.price, ledger: paywall.ledger };
}

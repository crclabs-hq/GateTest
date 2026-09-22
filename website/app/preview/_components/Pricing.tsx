import { TIERS } from "../../lib/checkout-tiers";

/**
 * Pricing as a table, every number imported from the checkout definition
 * (website/app/lib/checkout-tiers.ts) so the page cannot drift from what
 * Stripe charges.
 */
function price(cents: number, recurring?: boolean) {
  const dollars = cents % 100 === 0 ? (cents / 100).toString() : (cents / 100).toFixed(2);
  return `$${dollars}${recurring ? "/mo" : ""}`;
}

export function Pricing() {
  const rows = Object.entries(TIERS).map(([key, t]) => ({
    key,
    name: t.name,
    price: price(t.priceInCents, t.recurring),
    kind: t.recurring ? "subscription" : t.target === "url" ? "one-time · live site" : "one-time · repository",
    modules: t.modules,
    description: t.description,
  }));

  return (
    <div className="overflow-x-auto">
      <table className="v2-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Price</th>
            <th>Billing</th>
            <th>Scope</th>
            <th>What you get</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="whitespace-nowrap font-medium">{r.name}</td>
              <td className="v2-mono whitespace-nowrap">{r.price}</td>
              <td className="text-[var(--v2-muted)] whitespace-nowrap">{r.kind}</td>
              <td className="text-[var(--v2-muted)] whitespace-nowrap">{r.modules}</td>
              <td className="text-[var(--v2-muted)] min-w-[18rem]">{r.description}</td>
            </tr>
          ))}
          <tr>
            <td className="font-medium">Enterprise</td>
            <td className="v2-mono">contact</td>
            <td className="text-[var(--v2-muted)]">invoiced</td>
            <td className="text-[var(--v2-muted)]">same engine</td>
            <td className="text-[var(--v2-muted)]">custom scan volume, raised AI-review budget, priority support, invoicing on your terms</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-4 v2-kicker">Charged at checkout, no seats, no minimum. The engine is open source and free to run yourself; hosted runs are what is billed.</p>
    </div>
  );
}

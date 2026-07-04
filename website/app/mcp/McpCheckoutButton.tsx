'use client';

export default function McpCheckoutButton({ label }: { label: string }) {
  function handleClick() {
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'mcp' }),
    })
      .then((r) => r.json())
      .then((d: { checkoutUrl?: string }) => {
        if (d.checkoutUrl) window.location.href = d.checkoutUrl;
      })
      .catch(() => { window.location.href = '/mcp'; });
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-8 py-4 rounded-xl text-lg transition-all duration-200 shadow-xl shadow-blue-600/25 cursor-pointer"
    >
      {label}
    </button>
  );
}

"use client";

interface ComingSoonProps {
  readonly featureName: string;
  readonly routePath: string;
  readonly requiredTier?: "pro" | "enterprise" | "admin";
  readonly description?: string;
  readonly estimatedRelease?: string;
}

export function ComingSoon({
  featureName,
  routePath,
  requiredTier = "pro",
  description = "This feature is currently in development.",
  estimatedRelease = "Q3 2026",
}: ComingSoonProps) {
  const tierColors: Record<string, string> = {
    admin: "bg-purple-100 text-purple-700 border-purple-200",
    enterprise: "bg-red-100 text-red-700 border-red-200",
    pro: "bg-indigo-100 text-indigo-700 border-indigo-200",
  };

  return (
    <div className="w-full rounded-xl bg-white border border-gray-200 shadow-sm p-8 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4 border-b border-gray-100 pb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-gray-900">{featureName}</h2>
            <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border font-mono ${tierColors[requiredTier]}`}>
              {requiredTier} tier
            </span>
          </div>
          <p className="text-xs text-gray-400 font-mono">{routePath}</p>
        </div>
        <div className="bg-slate-50 border border-gray-200 rounded-lg px-4 py-2 text-right">
          <div className="text-[10px] text-gray-400 uppercase font-semibold tracking-wider">Target release</div>
          <div className="text-sm font-bold text-emerald-600 font-mono">{estimatedRelease}</div>
        </div>
      </div>

      <p className="text-sm text-gray-600 leading-relaxed mb-6 max-w-2xl">{description}</p>

      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-50 border border-gray-200 rounded-xl p-4">
        <p className="text-xs text-gray-500">
          Want early access? Let us know.
        </p>
        <a
          href={`mailto:hello@gatetest.ai?subject=${encodeURIComponent(`Early access: ${featureName}`)}`}
          className="text-xs font-semibold px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
        >
          Request early access
        </a>
      </div>
    </div>
  );
}

"use client";

/**
 * /admin/secrets — the step-up plumbing the panel hands to every dialog.
 *
 * `guarded(fn)` runs a call and, on `step_up_required`, opens the step-up
 * dialog (`open`), waits for it, and retries the call ONCE (logic.js
 * runWithStepUp). `finish(ok)` is what the dialog calls when it closes. A
 * pending ask is resolved "cancelled" if the ask is superseded or the page
 * goes away, so no caller is left waiting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { runWithStepUp } from "./logic";
import type { Guarded } from "./errors";

export function useStepUp(): { open: boolean; guarded: Guarded; finish: (ok: boolean) => void } {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const request = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpen(true);
      }),
    [],
  );

  const guarded: Guarded = useCallback(<T>(fn: () => Promise<T>) => runWithStepUp(fn, request), [request]);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  }, []);

  return { open, guarded, finish };
}

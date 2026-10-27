import { useEffect, useRef, useState } from "react";
import { watchUrl } from "../live/shareLink";
import { ensureShareLink, fetchShareLink, readCachedShareLink, rotateShareLink } from "../live/shareLinkStore";
import { currentUserId } from "../db";
import { track } from "../telemetry";

export type ShareLinkHandle = {
  token: string | null;
  // Confirmed against the ledger this session; only a confirmed link is sendable.
  confirmed: boolean;
  // A revalidation has settled, so an unconfirmed link is worth warning about.
  checked: boolean;
  busy: boolean;
  error: boolean | "limit";
  copied: boolean;
  create: () => Promise<boolean>;
  replace: () => Promise<void>;
  // Resolves true once the link was handed to the share sheet or copied.
  send: () => Promise<boolean>;
};

// Every mounted view of the link (recorder, Home) shows one address: a create or
// replace in one must reach the others, or a stale view sends a revoked link.
const listeners = new Set<(token: string) => void>();
const announce = (token: string) => listeners.forEach(l => l(token));

// The runner's standing share link (docs/live-sharing.md). The cache is only a
// copy for offline rendering: it is confirmed against the ledger on mount and on
// every return to the foreground, since a link replaced on another device would
// otherwise still be offered here.
export function useShareLink(showToast?: (msg: string, type?: string) => void): ShareLinkHandle {
  const [token, setToken] = useState<string | null>(() => readCachedShareLink(currentUserId()));
  const [confirmed, setConfirmed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<boolean | "limit">(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); }, []);
  const flashCopied = () => {
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2500);
  };

  useEffect(() => {
    const onToken = (next: string) => { setToken(next); setConfirmed(true); setError(false); setCopied(false); };
    listeners.add(onToken);
    return () => { listeners.delete(onToken); };
  }, []);

  useEffect(() => {
    let alive = true;
    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      void fetchShareLink().then((next) => {
        if (!alive) return;
        setChecked(true);
        if (next === null) return; // offline: keep the cached copy, unconfirmed
        setToken(next);
        setConfirmed(true);
        setError(false);
      });
    };
    revalidate();
    document.addEventListener("visibilitychange", revalidate);
    return () => { alive = false; document.removeEventListener("visibilitychange", revalidate); };
  }, []);

  const create = async () => {
    setBusy(true);
    setError(false);
    const next = await ensureShareLink();
    setBusy(false);
    if (!next) { setError(true); return false; }
    announce(next);
    track("live_share_link_created", {});
    return true;
  };

  const replace = async () => {
    setBusy(true);
    setError(false);
    const { token: next, limit } = await rotateShareLink();
    setBusy(false);
    if (!next) { setError(limit ? "limit" : true); return; }
    announce(next);
    track("live_share_link_rotated", {});
  };

  // The OS share sheet where the WebView offers one, the clipboard otherwise,
  // and the raw URL as a last resort so the link is never out of reach.
  const send = async () => {
    if (!token) return false;
    const url = watchUrl(token);
    try {
      if (navigator.share) { await navigator.share({ url }); return true; }
    } catch (err) {
      // Dismissing the sheet is a decision: copying anyway would answer a "no" with a "done".
      if (err instanceof Error && err.name === "AbortError") return false;
    }
    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
      return true;
    } catch {
      showToast?.(url);
      return false;
    }
  };

  return { token, confirmed, checked, busy, error, copied, create, replace, send };
}

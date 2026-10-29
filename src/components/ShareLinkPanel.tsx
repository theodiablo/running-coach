import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Link2, Loader, RefreshCw } from "lucide-react";
import { shareLinkState } from "../live/shareLink";
import type { ShareLinkHandle } from "../hooks/useShareLink";
import { ShareLinkConfirm } from "./ShareLinkConfirm";

type ShareLinkPanelProps = {
  link: ShareLinkHandle;
  // Whether runs from here are going out on the link; off dims it, never hides
  // it, because Replace must stay reachable to cut someone off outside a run.
  active: boolean;
  publicUnavailable?: boolean;
  // Off where the surrounding screen already explains the link (onboarding).
  confirmCreate?: boolean;
  onSent?: () => void;
};

// The link block shared by the recorder, onboarding and Home: create, send,
// replace, and the one status line under it.
export function ShareLinkPanel({ link, active, publicUnavailable = false, confirmCreate = true, onSent }: ShareLinkPanelProps) {
  const { t } = useTranslation();
  const [askCreate, setAskCreate] = useState(false);
  const [askReplace, setAskReplace] = useState(false);
  const state = shareLinkState({ token: link.token, sharing: active, busy: link.busy, confirmed: link.confirmed });
  const send = async () => { if (await link.send()) onSent?.(); };

  return (
    <div className="space-y-1.5">
      {state.kind === "busy" ? (
        <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-300">
          <Loader size={15} className="animate-spin" />{t("liveShare.link.working")}
        </div>
      ) : state.kind === "none" ? (
        <button onClick={() => (confirmCreate ? setAskCreate(true) : void link.create())}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 active:scale-95 transition-[background-color,transform]">
          <Link2 size={16} className="text-sky-300" />{t("liveShare.link.create")}
        </button>
      ) : (
        <div className={"flex items-center gap-2 rounded-xl bg-sky-500/10 border border-sky-500/30 px-3 py-2 text-sm transition-opacity "
          + (state.active ? "" : "opacity-50")}>
          <Link2 size={15} className="text-sky-300 shrink-0" />
          <span className="flex-1 min-w-0 truncate text-left font-mono text-[12px] text-sky-200">
            {state.url.replace(/^https?:\/\//, "")}
          </span>
          <button onClick={() => { void send(); }} disabled={!state.sendable}
            className="flex items-center gap-1 text-slate-300 hover:text-white underline decoration-slate-600 disabled:opacity-50 disabled:no-underline">
            {link.copied ? <Check size={14} className="text-emerald-400" /> : null}
            {t(link.copied ? "liveShare.link.copied" : "liveShare.link.share")}
          </button>
          <button onClick={() => setAskReplace(true)} aria-label={t("liveShare.link.replace")}
            className="p-1 text-slate-400 hover:text-white"><RefreshCw size={15} /></button>
        </div>
      )}
      {publicUnavailable ? (
        <p className="text-[11px] text-amber-300/90 leading-snug px-1">{t("liveShare.link.unavailable")}</p>
      ) : link.error ? (
        <p className="text-[11px] text-amber-300/90 leading-snug px-1">
          {t(link.error === "limit" ? "liveShare.link.limit" : "liveShare.link.failed")}
        </p>
      ) : state.kind === "link" && !state.sendable && link.checked ? (
        <p className="text-[11px] text-amber-300/90 leading-snug px-1">{t("liveShare.link.unconfirmed")}</p>
      ) : (
        <p className="text-[11px] text-slate-500 leading-snug px-1">{t("liveShare.link.hint")}</p>
      )}

      {/* Portalled: the panel sits inside animated sheets, whose transform would
          otherwise trap a fixed overlay. Claiming the link carries the
          explanation, as the moment a permanent address starts existing. */}
      {askCreate && createPortal(
        <ShareLinkConfirm title={t("liveShare.link.createTitle")} body={t("liveShare.link.createBody")}
          acceptLabel={t("liveShare.link.createAccept")}
          onCancel={() => setAskCreate(false)} onAccept={() => { setAskCreate(false); void link.create(); }} />,
        document.body,
      )}
      {askReplace && createPortal(
        <ShareLinkConfirm title={t("liveShare.link.replaceTitle")} body={t("liveShare.link.replaceBody")}
          acceptLabel={t("liveShare.link.replaceAccept")}
          onCancel={() => setAskReplace(false)} onAccept={() => { setAskReplace(false); void link.replace(); }} />,
        document.body,
      )}
    </div>
  );
}

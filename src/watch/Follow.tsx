// Following a runner from the public watch page: the name prompt, and the one
// control the single-runner page shows. Nothing is stored until the visitor
// confirms (src/live/followList.ts).

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, UserPlus, Users, X } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { FOLLOW_MAX, FOLLOW_NAME_MAX, followRunner, sameNameAs, type FollowedRunner } from "../live/followList";
import { useFollows } from "./useFollows";
import { WATCH_LIST_PATH } from "../live/shareLink";

export function FollowSheet(
  { token, list, onDone, onClose }:
  { token: string; list: FollowedRunner[]; onDone: (list: FollowedRunner[]) => void; onClose: () => void },
) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [name, setName] = useState("");
  const [replace, setReplace] = useState<FollowedRunner | null>(null);
  const [full, setFull] = useState(false);

  const commit = (replaces: string | null) => {
    const out = followRunner(token, name, replaces);
    if (out.ok) onDone(out.list);
    else setFull(true);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A runner who replaced their link sends a new one, which looks exactly like
    // someone new: only the viewer can say it's the same person.
    const same = sameNameAs(list, token, name);
    if (same && !replace) { setReplace(same); return; }
    commit(null);
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-end md:items-center justify-center bg-black/70 animate-overlay-fade"
      onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="follow-title"
        onClick={e => e.stopPropagation()}
        className="w-full md:max-w-md max-h-full overflow-y-auto bg-[#111c33] border-t md:border border-slate-700
          rounded-t-3xl md:rounded-3xl px-5 pt-2.5 md:pt-5 flex flex-col gap-4 animate-scale-in"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
        <div className="md:hidden self-center w-10 h-1 rounded-full bg-slate-700" aria-hidden />
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id="follow-title" className="text-[19px] font-extrabold">{t("liveShare.public.follow.title")}</h2>
            <p className="mt-1 text-[13px] text-slate-400 leading-snug">{t("liveShare.public.follow.body", { max: FOLLOW_MAX })}</p>
          </div>
          <button onClick={onClose} aria-label={t("liveShare.public.close")}
            className="shrink-0 grid place-items-center w-11 h-11 rounded-full bg-slate-800 text-slate-400 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
        {replace ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-200">{t("liveShare.public.follow.replaceQ", { name: replace.name })}</p>
            <div className="grid gap-2">
              <button type="button" onClick={() => commit(replace.token)}
                className="rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold py-2.5 text-sm">
                {t("liveShare.public.follow.replaceYes")}
              </button>
              <button type="button" onClick={() => commit(null)}
                className="rounded-xl bg-slate-800 border border-slate-700 text-slate-200 font-semibold py-2.5 text-sm">
                {t("liveShare.public.follow.replaceNo")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="follow-name" className="block text-xs font-semibold text-slate-300">{t("liveShare.public.follow.nameLabel")}</label>
            <input id="follow-name" value={name} onChange={e => setName(e.target.value)} maxLength={FOLLOW_NAME_MAX}
              autoFocus autoComplete="off" placeholder={t("liveShare.public.follow.namePlaceholder")}
              className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-orange-500" />
            <button type="submit"
              className="w-full rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold py-2.5 text-sm">
              {t("liveShare.public.follow.confirm")}
            </button>
          </form>
        )}
        {full && <p role="alert" className="text-xs text-amber-200">{t("liveShare.public.follow.full", { max: FOLLOW_MAX })}</p>}
        <p className="text-xs text-slate-500 leading-snug">{t("liveShare.public.follow.savedHere")}</p>
      </section>
    </div>
  );
}

// The single-runner page's way into the list. `large` in the idle card, where a
// link shared ahead of a race is most likely being opened.
export function FollowControl({ token, large = false }: { token: string; large?: boolean }) {
  const { t } = useTranslation();
  const [list, setList] = useFollows();
  const [open, setOpen] = useState(false);
  const followed = list.some(r => r.token === token);
  const pill = "shrink-0 inline-flex items-center gap-1.5 min-h-9 px-3 rounded-full text-[13px] font-bold";
  const big = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold";

  if (followed) {
    return (
      <a href={WATCH_LIST_PATH}
        className={(large ? big : pill) + " text-emerald-300 bg-emerald-500/10 border border-emerald-500/40"}>
        <Check size={large ? 16 : 14} aria-hidden />
        {large ? t("liveShare.public.follow.seeAll", { count: list.length }) : t("liveShare.public.follow.following")}
      </a>
    );
  }
  return (
    <>
      <span className={large ? "flex flex-col items-center gap-2" : "contents"}>
        <button type="button" onClick={() => setOpen(true)}
          className={(large ? big : pill) + " text-slate-200 border border-slate-600 hover:border-slate-400"}>
          <UserPlus size={large ? 16 : 14} aria-hidden />{t("liveShare.public.follow.cta")}
        </button>
        {large && list.length > 0 && (
          <a href={WATCH_LIST_PATH} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
            <Users size={13} aria-hidden />{t("liveShare.public.follow.seeAll", { count: list.length })}
          </a>
        )}
      </span>
      {open && <FollowSheet token={token} list={list}
        onDone={next => { setList(next); setOpen(false); }} onClose={() => setOpen(false)} />}
    </>
  );
}

import { useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { coachLinkTarget, type CoachLinkTarget } from "../utils/coachLinks";

// Two kinds of link, one rule: only an allowlisted in-app destination becomes
// something the runner can press. The coach is told never to emit a URL, but a
// prompt rule is not enforcement — a hallucinated external link rendered as a
// real anchor sends the runner somewhere we never vouched for, so everything
// outside the allowlist keeps its text and loses its href.
const CoachLink = ({ target, onNavigate, children }: {
  target: CoachLinkTarget;
  onNavigate: (t: CoachLinkTarget) => void;
  children?: ReactNode;
}) => (
  <button type="button" onClick={() => onNavigate(target)}
    className="text-orange-400 underline underline-offset-2 hover:text-orange-300 text-left">
    {children}
  </button>
);

// The model replies in markdown (headers, bold, tables); rendered via
// react-markdown rather than manually injecting raw HTML through a sanitizer
// pair — it emits real React elements, so there's no HTML string to sanitize.
// Component overrides keep every element inside the narrow chat bubble's
// dark slate / orange-500 palette instead of react-markdown's default
// (unstyled, full-size) tags.
const mdComponents = (onNavigate?: (t: CoachLinkTarget) => void) => ({
  h1: (p: ComponentPropsWithoutRef<"p">) => <p className="text-sm font-bold text-slate-100 mt-2 mb-1 first:mt-0" {...p}/>,
  h2: (p: ComponentPropsWithoutRef<"p">) => <p className="text-sm font-bold text-slate-100 mt-2 mb-1 first:mt-0" {...p}/>,
  h3: (p: ComponentPropsWithoutRef<"p">) => <p className="text-sm font-semibold text-slate-100 mt-2 mb-1 first:mt-0" {...p}/>,
  p: (p: ComponentPropsWithoutRef<"p">) => <p className="mb-2 last:mb-0 leading-relaxed" {...p}/>,
  strong: (p: ComponentPropsWithoutRef<"strong">) => <strong className="font-semibold text-slate-100" {...p}/>,
  ul: (p: ComponentPropsWithoutRef<"ul">) => <ul className="list-disc pl-4 mb-2 space-y-0.5 last:mb-0" {...p}/>,
  ol: (p: ComponentPropsWithoutRef<"ol">) => <ol className="list-decimal pl-4 mb-2 space-y-0.5 last:mb-0" {...p}/>,
  li: (p: ComponentPropsWithoutRef<"li">) => <li className="leading-relaxed" {...p}/>,
  a: ({ children, href }: ComponentPropsWithoutRef<"a">) => {
    const target = coachLinkTarget(href);
    return target && onNavigate
      ? <CoachLink target={target} onNavigate={onNavigate}>{children}</CoachLink>
      : <span>{children}</span>;
  },
  code: (p: ComponentPropsWithoutRef<"code">) => <code className="bg-slate-900/60 px-1 py-0.5 rounded text-orange-300 text-xs font-mono" {...p}/>,
  pre: (p: ComponentPropsWithoutRef<"pre">) => <pre className="bg-slate-900/60 rounded-lg p-2 overflow-x-auto text-xs font-mono mb-2 last:mb-0" {...p}/>,
  blockquote: (p: ComponentPropsWithoutRef<"blockquote">) => <blockquote className="border-l-2 border-slate-600 pl-2 italic text-slate-400 mb-2 last:mb-0" {...p}/>,
  hr: () => <hr className="border-slate-700 my-2"/>,
  table: (p: ComponentPropsWithoutRef<"table">) => <div className="overflow-x-auto mb-2 last:mb-0"><table className="w-full text-xs border-collapse" {...p}/></div>,
  th: (p: ComponentPropsWithoutRef<"th">) => <th className="border border-slate-700 px-2 py-1 text-left font-semibold bg-slate-800/60" {...p}/>,
  td: (p: ComponentPropsWithoutRef<"td">) => <td className="border border-slate-700 px-2 py-1 align-top" {...p}/>,
});


// react-markdown drops every scheme but http/https/mailto/tel, so `app:` would
// reach the anchor override as an empty href. Let it through untouched and let
// the override's allowlist be the only gate; everything else keeps the default
// treatment, and the override strips its href regardless.
const urlTransform = (url: string) => (coachLinkTarget(url) ? url : defaultUrlTransform(url));

export const CoachText = ({ text, onNavigate }: {
  text: string;
  onNavigate?: (target: CoachLinkTarget) => void;
}) => {
  const components = useMemo(() => mdComponents(onNavigate), [onNavigate]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
};

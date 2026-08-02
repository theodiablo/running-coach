import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { isNative, nativeBuildLabel } from "../native";
import { getConsent, captureError } from "../telemetry";
// Bound t (not the hook): ErrorBoundary is a class and renders only on crash,
// by which point initI18n has run, so the active language is available.
import { t } from "../i18n";

const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || "";

// App-wide crash guard. A render-time exception anywhere below this boundary
// would otherwise white-screen the user; instead we show a friendly fallback
// with a reload, and feed the crash to telemetry under the single consent rule:
// auto-report on BOTH web and native whenever the user has granted analytics
// consent (getConsent()), and never otherwise. Capture goes through the bundled
// captureException API (see telemetry/posthog.ts) — PostHog's remote
// exception-autocapture bundle is blocked by our CSP. On native this also covers
// uncaught window errors / promise rejections via the listeners in
// componentDidMount (on web those are handled by installGlobalErrorHandlers).
//
// Class component because error boundaries have no hooks equivalent.
type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = {
  error: Error | null;
  decision: "sent" | null;
  showDetails: boolean;
  copied: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  info: ErrorInfo | null;
  kind: string;
  onWindowError?: (e: ErrorEvent) => void;
  onUnhandledRejection?: (e: PromiseRejectionEvent) => void;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    // decision: null = undecided (native prompt showing), "sent" | "declined".
    this.state = { error: null, decision: null, showDetails: false, copied: false };
    this.info = null;
    this.kind = "react";
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, decision: null };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.info = info;
    this.kind = "react";
    // Auto-report on web and native alike, consent permitting (state.error is
    // already set by getDerivedStateFromError before this runs).
    this.maybeReport();
  }

  componentDidMount() {
    if (!isNative) return;
    this.onWindowError = (e) => {
      this.info = null;
      this.kind = "window.error";
      this.setState(
        { error: e.error || new Error(e.message || "Unknown error"), decision: null, showDetails: true, copied: false },
        () => this.maybeReport(),
      );
    };
    this.onUnhandledRejection = (e) => {
      this.info = null;
      this.kind = "unhandledrejection";
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      this.setState(
        { error: err, decision: null, showDetails: true, copied: false },
        () => this.maybeReport(),
      );
    };
    window.addEventListener("error", this.onWindowError);
    window.addEventListener("unhandledrejection", this.onUnhandledRejection);
  }

  // Send the current crash once, if analytics consent is granted. Called after
  // state.error is populated (directly in componentDidCatch, via the setState
  // callback in the native window/rejection listeners).
  maybeReport() {
    if (this.state.decision === "sent" || !this.state.error || !getConsent()) return;
    this.report();
    this.setState({ decision: "sent" });
  }

  componentWillUnmount() {
    if (!isNative) return;
    if (this.onWindowError) window.removeEventListener("error", this.onWindowError);
    if (this.onUnhandledRejection) window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
  }

  traceText() {
    const err = this.state.error;
    if (!err) return "";
    return [
      "Running Coach crash report",
      "Time: " + new Date().toISOString(),
      "Kind: " + this.kind,
      "Native: " + String(isNative),
      // Without this a native trace can't be tied to a released build, so a
      // crash from a stale install is indistinguishable from a regression.
      isNative ? "App: " + (nativeBuildLabel() || "unknown") : "",
      "URL: " + window.location.href,
      "User agent: " + navigator.userAgent,
      "",
      "Error: " + (err.name || "Error") + ": " + (err.message || String(err)),
      "",
      err.stack || "No JS stack available.",
      this.info?.componentStack ? "\nComponent stack:\n" + this.info.componentStack : "",
    ].filter(Boolean).join("\n");
  }

  report() {
    if (!this.state.error) return;
    captureError(this.state.error, {
      kind: this.kind,
      componentStack: this.info?.componentStack,
      trace: this.traceText(),
    });
  }

  toggleDetails = () => this.setState(prev => ({ showDetails: !prev.showDetails }));

  copyTrace = () => {
    const text = this.traceText();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this.setState({ copied: true }))
        .catch(() => this.setState({ showDetails: true }));
    } else {
      this.setState({ showDetails: true });
    }
  };

  emailTrace = () => {
    if (!SUPPORT_EMAIL) return;
    const subject = encodeURIComponent("Running Coach crash trace");
    const body = encodeURIComponent(this.traceText());
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  };

  // Full reload — after a render crash the React tree is in an unknown state.
  reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="h-screen bg-slate-900 text-white flex items-center justify-center p-6">
        <div className="max-w-sm w-full bg-slate-800 rounded-2xl p-6 text-center space-y-4">
          <div className="flex justify-center">
            <AlertTriangle className="text-orange-400" size={32} />
          </div>
          <div className="space-y-1">
            <p className="text-base font-semibold">{t("app.crash.title")}</p>
            <p className="text-sm text-slate-400">
              {t("app.crash.body")}
            </p>
          </div>

          <div className="space-y-2 text-left">
            <button onClick={this.toggleDetails}
              className="w-full py-2 rounded-xl text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
              {this.state.showDetails ? t("app.crash.hideTrace") : t("app.crash.showTrace")}
            </button>
            {this.state.showDetails && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 border border-slate-700 p-3 text-[11px] text-slate-300 text-left">
                {this.traceText()}
              </pre>
            )}
            <div className={"grid gap-2 " + (SUPPORT_EMAIL ? "grid-cols-2" : "grid-cols-1")}>
              <button onClick={this.copyTrace}
                className="py-2 rounded-xl text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                {this.state.copied ? t("app.crash.copied") : t("app.crash.copyTrace")}
              </button>
              {SUPPORT_EMAIL ? (
                <button onClick={this.emailTrace}
                  className="py-2 rounded-xl text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                  {t("app.crash.emailTrace")}
                </button>
              ) : null}
            </div>
          </div>

          {this.state.decision === "sent" && (
            <p className="text-xs text-emerald-400">{t("app.crash.sent")}</p>
          )}
          <button onClick={this.reload}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white transition-colors">
            {t("app.crash.reload")}
          </button>
        </div>
      </div>
    );
  }
}

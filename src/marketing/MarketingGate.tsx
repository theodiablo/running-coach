import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LANGS, currentLang } from "../i18n";
import { X, Smartphone, ArrowRight, MessageCircle, Download, Globe } from "lucide-react";
// Self-hosted Archivo (the design's typeface). These live in this web-only lazy
// chunk, so the font never ships in the native APK, and they're served from our
// own origin — no Google Fonts request, so nothing to add to the CSP.
import "@fontsource/archivo/500.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/archivo/800.css";
import "@fontsource/archivo/900.css";
import LoginScreen from "../LoginScreen";
import { BrandLogo } from "../components/BrandLogo";
import {
  PRIVACY_URL,
  DISCLAIMER_URL,
  PLAY_STORE_BETA_URL,
  TESTFLIGHT_BETA_URL,
  TIP_JAR_URL,
} from "../constants";
// Registers the web-only "marketing" i18n namespace (brand + hero come from
// copy.json, the source shared with the OG-image generator). Importing it here
// keeps those strings in this chunk — out of the APK.
import { ensureMarketingI18n, setMarketingLocale } from "./i18n";
// Real app screenshots, imported so Vite bundles them into this web-only chunk
// (dropped from the APK along with the rest of the marketing code).
import planShot from "./assets/02-plan.png";
import coachShot from "./assets/03-coach-chat.png";
import racesShot from "./assets/05b-races-find-a-race.png";
import badgesShot from "./assets/08-progress-badges.png";

ensureMarketingI18n();

// Web-only marketing landing shown at the root path to signed-out visitors.
// The native (Capacitor) shell never renders this — it goes straight to
// LoginScreen — and the build-time VITE_NATIVE_BUILD flag drops this whole
// chunk from the APK (see App.tsx). Every CTA opens the existing LoginScreen in
// a full-screen modal, so all auth flows stay in one place.

const FONT_STACK = "'Archivo', ui-sans-serif, system-ui, sans-serif";

// A phone frame around arbitrary content. The hero renders the coach-chat
// exchange mock inside it (the coach chat is a full-screen modal in the app, so
// no bottom nav is shown — same as the real thing).
function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="w-[288px] sm:w-[330px]">
      <div className="rounded-[36px] border-[10px] border-[#1B2740] bg-[#0B1220] overflow-hidden shadow-[0_40px_80px_rgba(0,0,0,0.55)]">
        <div className="relative h-[520px] sm:h-[560px]">{children}</div>
      </div>
    </div>
  );
}

export default function MarketingGate() {
  const { t } = useTranslation("marketing");
  const [showLogin, setShowLogin] = useState(false);
  const [loginMode, setLoginMode] = useState<"signin" | "signup">("signup");
  // "Get started" CTAs open the form set up to create an account; "Log in" /
  // "already have an account" open it set up to sign in. The modal unmounts on
  // close, so reopening always re-seeds LoginScreen from the intent passed here.
  const openLogin = (mode: "signin" | "signup") => {
    setLoginMode(mode);
    setShowLogin(true);
  };
  const signup = () => openLogin("signup");
  const signin = () => openLogin("signin");

  const stats = [
    { value: t("stats.plans.value"), label: t("stats.plans.label") },
    { value: t("stats.adapts.value"), label: t("stats.adapts.label") },
    { value: t("stats.devices.value"), label: t("stats.devices.label") },
  ];

  return (
    <div className="min-h-screen bg-[#0B1220] text-[#F1F5F9]" style={{ fontFamily: FONT_STACK }}>
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Header */}
        <header className="flex items-center justify-between py-6">
          <div className="flex items-center gap-3">
            <BrandLogo size={22} className="text-[#F97316]" />
            <span className="font-extrabold text-[20px] tracking-[-0.3px]">{t("brand")}</span>
          </div>
          <nav className="flex items-center gap-4 sm:gap-7 text-[15px] font-semibold">
            <a href="#features" className="hidden md:inline text-[#8B98AC] hover:text-[#FDBA74] transition-colors">
              {t("nav.features")}
            </a>
            <a href="#races" className="hidden md:inline text-[#8B98AC] hover:text-[#FDBA74] transition-colors">
              {t("nav.races")}
            </a>
            <button type="button" onClick={signin} className="text-[#8B98AC] hover:text-[#F1F5F9] transition-colors">
              {t("nav.login")}
            </button>
            <button
              type="button"
              onClick={signup}
              className="bg-[#F97316] text-[#0B1220] px-5 py-2.5 rounded-full font-bold hover:bg-[#FDBA74] transition-colors"
            >
              {t("nav.getStarted")}
            </button>
          </nav>
        </header>

        {/* Hero */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-10 lg:gap-12 items-center pt-4 pb-16 lg:pb-20">
          <div className="flex flex-col gap-5">
            <span className="text-[#F97316] font-bold text-[13px] tracking-[2px] uppercase">
              {t("hero.eyebrow")}
            </span>
            <h1 className="text-4xl sm:text-5xl lg:text-[52px] font-black leading-[1.08] tracking-[-1.5px]">
              {t("heroLine1")}
              <br />
              <span className="text-[#F97316]">{t("heroLine2")}</span>
            </h1>
            <p className="text-[17px] sm:text-[19px] leading-relaxed text-[#B7C2D2] max-w-[52ch]">
              {t("hero.body")}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 sm:items-center mt-2">
              <button
                type="button"
                onClick={signup}
                className="bg-[#F97316] text-[#0B1220] px-8 py-4 rounded-full font-extrabold text-[17px] hover:bg-[#FDBA74] transition-colors"
              >
                {t("hero.ctaPrimary")}
              </button>
              <button
                type="button"
                onClick={signin}
                className="border border-[#2A3A55] text-[#F1F5F9] px-6 py-[15px] rounded-full font-bold text-[15px] hover:border-[#3B4E6B] hover:bg-[#0F1826] transition-colors"
              >
                {t("hero.ctaSecondary")}
              </button>
            </div>
            <p className="text-[13px] text-[#8B98AC]">
              {t("hero.freeNote")}
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <a
                href={TESTFLIGHT_BETA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[14px] font-semibold text-[#8B98AC] hover:text-[#FDBA74] transition-colors"
              >
                <Smartphone size={16} />
                {t("hero.iosBeta")}
                <ArrowRight size={15} />
              </a>
              <a
                href={PLAY_STORE_BETA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[14px] font-semibold text-[#8B98AC] hover:text-[#FDBA74] transition-colors"
              >
                <Smartphone size={16} />
                {t("hero.androidBeta")}
                <ArrowRight size={15} />
              </a>
            </div>
            <div className="flex flex-wrap gap-x-9 gap-y-4 mt-3">
              {stats.map((s) => (
                <div key={s.value} className="flex flex-col gap-0.5">
                  <span className="font-extrabold text-[22px] sm:text-[24px] text-[#F97316]">{s.value}</span>
                  <span className="text-[#8B98AC] text-[14px]">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-center lg:justify-end">
            <PhoneFrame>
              <CoachChatMock />
            </PhoneFrame>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="flex flex-col gap-12 sm:gap-14 pb-20 sm:pb-24">
          <div className="flex flex-col gap-3 max-w-[60ch]">
            <h2 className="text-3xl sm:text-[38px] font-black tracking-[-1px]">
              {t("features.heading")}
            </h2>
            <p className="text-[#B7C2D2] text-[17px] leading-relaxed">
              {t("features.sub")}
            </p>
          </div>

          {/* Three primary feature cards — the coach leads. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard
              img={coachShot}
              imgAlt={t("features.coach.alt")}
              title={t("features.coach.title")}
              body={t("features.coach.body")}
            />
            <FeatureCard
              img={planShot}
              imgAlt={t("features.plan.alt")}
              title={t("features.plan.title")}
              body={t("features.plan.body")}
            />
            {/* Third card uses a purpose-built live-tracking mock instead of a screenshot. */}
            <div className="bg-[#0F1826] border border-[#1E2A3D] rounded-[20px] overflow-hidden flex flex-col gap-5 pb-6">
              <LiveTrackerMock />
              <div className="px-6 flex flex-col gap-2">
                <h3 className="text-[20px] font-extrabold">{t("features.track.title")}</h3>
                <p className="text-[#8B98AC] text-[15px] leading-relaxed">
                  {t("features.track.body")}
                </p>
              </div>
            </div>
          </div>

          {/* Two wide cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <WideCard
              id="races"
              img={racesShot}
              imgAlt={t("features.races.alt")}
              title={t("features.races.title")}
              body={t("features.races.body")}
            />
            <WideCard
              img={badgesShot}
              imgAlt={t("features.progress.alt")}
              title={t("features.progress.title")}
              body={t("features.progress.body")}
            />
          </div>
        </section>

        {/* Import strip — switching cost is the #1 reason runners don't try a
            new app, so say out loud that their history comes with them. */}
        <section className="border border-[#1E2A3D] bg-[#0F1826] rounded-[20px] px-6 py-6 sm:px-8 flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6 mb-14 sm:mb-16">
          <div className="w-11 h-11 rounded-[14px] bg-[#131C2B] border border-[#2A3A55] flex items-center justify-center flex-shrink-0">
            <Download size={20} className="text-[#F97316]" />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-[18px] font-extrabold">{t("import.title")}</h3>
            <p className="text-[#8B98AC] text-[15px] leading-relaxed">
              {t("import.body")}
            </p>
          </div>
        </section>

        {/* Closing CTA band */}
        <section className="bg-gradient-to-b from-[#F97316] to-[#EA580C] rounded-[24px] px-6 py-14 sm:px-16 sm:py-16 flex flex-col items-center gap-5 text-center mb-20 sm:mb-24">
          <h2 className="text-[#0B1220] text-3xl sm:text-[40px] font-black tracking-[-1px]">
            {t("cta.heading")}
          </h2>
          <p className="text-[#3B2107] text-[16px] sm:text-[18px] font-semibold max-w-[48ch]">
            {t("cta.body")}
          </p>
          <div className="flex flex-col sm:flex-row items-center gap-4 mt-2">
            <button
              type="button"
              onClick={signup}
              className="bg-[#0B1220] text-[#F1F5F9] px-8 py-4 rounded-full font-extrabold text-[17px] hover:bg-[#131c2b] transition-colors"
            >
              {t("cta.primary")}
            </button>
            <a
              href={TESTFLIGHT_BETA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[15px] font-bold text-[#3B2107] hover:text-[#0B1220] transition-colors"
            >
              <Smartphone size={16} />
              {t("cta.iosBeta")}
              <ArrowRight size={15} />
            </a>
            <a
              href={PLAY_STORE_BETA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[15px] font-bold text-[#3B2107] hover:text-[#0B1220] transition-colors"
            >
              <Smartphone size={16} />
              {t("cta.androidBeta")}
              <ArrowRight size={15} />
            </a>
          </div>
        </section>

        {/* Footer */}
        <footer className="flex flex-col sm:flex-row items-center justify-between gap-5 pb-10 text-[14px] text-[#8B98AC]">
          <div className="flex items-center gap-2.5">
            <BrandLogo size={16} className="text-[#F97316]" />
            <span className="font-bold text-[#B7C2D2]">{t("brand")}</span>
          </div>
          {/* Language selector — setMarketingLocale flips the already-bundled
              landing copy instantly (no app-chunk download on the critical path),
              persists rc_lang so the choice sticks into LoginScreen and the next
              visit, and warms the app bundle in the background for login. */}
          <div className="flex items-center gap-2.5" role="group" aria-label={t("nav.language")}>
            <Globe size={15} className="text-[#8B98AC]" />
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setMarketingLocale(l.id)}
                aria-pressed={currentLang() === l.id}
                className={
                  "font-semibold transition-colors " +
                  (currentLang() === l.id ? "text-[#F97316]" : "hover:text-[#F1F5F9]")
                }
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="flex gap-6">
            {TIP_JAR_URL && (
              <a href={TIP_JAR_URL} target="_blank" rel="noopener noreferrer" className="hover:text-[#FDBA74] transition-colors">
                {t("footer.support")}
              </a>
            )}
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="hover:text-[#FDBA74] transition-colors">
              {t("footer.privacy")}
            </a>
            <a href={DISCLAIMER_URL} target="_blank" rel="noopener noreferrer" className="hover:text-[#FDBA74] transition-colors">
              {t("footer.safety")}
            </a>
          </div>
        </footer>
      </div>

      {/* Login modal — reuses the full LoginScreen over a backdrop. */}
      {showLogin && (
        <div className="fixed inset-0 z-50">
          <div className="relative min-h-screen">
            <button
              type="button"
              onClick={() => setShowLogin(false)}
              aria-label={t("closeLogin")}
              className="absolute top-4 right-4 z-10 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <X size={22} />
            </button>
            <LoginScreen intent={loginMode} />
          </div>
        </div>
      )}
    </div>
  );
}

function FeatureCard({ img, imgAlt, title, body }: { img: string; imgAlt: string; title: string; body: string }) {
  return (
    <div className="bg-[#0F1826] border border-[#1E2A3D] rounded-[20px] overflow-hidden flex flex-col gap-5 pb-6">
      <div className="h-[280px] sm:h-[300px] overflow-hidden border-b border-[#1E2A3D]">
        <img src={img} alt={imgAlt} className="w-full" />
      </div>
      <div className="px-6 flex flex-col gap-2">
        <h3 className="text-[20px] font-extrabold">{title}</h3>
        <p className="text-[#8B98AC] text-[15px] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function WideCard({
  id,
  img,
  imgAlt,
  title,
  body,
}: {
  id?: string;
  img: string;
  imgAlt: string;
  title: string;
  body: string;
}) {
  return (
    <div id={id} className="bg-[#0F1826] border border-[#1E2A3D] rounded-[20px] p-6 sm:p-8 flex gap-6 sm:gap-7 items-center">
      <div className="w-[120px] sm:w-[150px] h-[230px] sm:h-[280px] flex-shrink-0 rounded-[16px] overflow-hidden border border-[#1E2A3D]">
        <img src={img} alt={imgAlt} className="w-full" />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[20px] font-extrabold">{title}</h3>
        <p className="text-[#8B98AC] text-[15px] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// Hero visual: a hand-built coach-chat exchange showing the real
// propose-and-confirm flow ("my knee hurts" → a safe proposed edit the user
// must approve). Purpose-built like LiveTrackerMock, not a screenshot, and
// deliberately honest: the coach only ever *proposes* — the Apply step is the
// user's, exactly as in CoachChat.
function CoachChatMock() {
  const { t } = useTranslation("marketing");
  return (
    <div className="absolute inset-0 flex flex-col bg-[#0B1220] text-left" aria-hidden="true">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1E2A3D]">
        <MessageCircle size={16} className="text-[#F97316]" />
        <span className="font-extrabold text-[15px]">{t("mock.coach")}</span>
      </div>
      <div className="flex-1 flex flex-col gap-3 px-3.5 py-4 overflow-hidden">
        <div className="self-end max-w-[85%] bg-[#F97316] text-[#0B1220] font-semibold text-[13px] leading-snug px-3.5 py-2.5 rounded-[16px] rounded-br-[4px]">
          {t("mock.userMsg")}
        </div>
        <div className="self-start max-w-[90%] bg-[#131C2B] border border-[#1E2A3D] text-[#D7DFEA] text-[13px] leading-snug px-3.5 py-2.5 rounded-[16px] rounded-bl-[4px]">
          {t("mock.reply1")}
        </div>
        <div className="self-start w-[94%] bg-[#0F1826] border border-[#2A3A55] rounded-[14px] p-3 flex flex-col gap-2.5">
          <span className="text-[10px] font-bold tracking-[1.5px] text-[#8B98AC] uppercase">
            {t("mock.proposedChanges")}
          </span>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-[#8B98AC]">{t("mock.tue")}</span>
            <span className="font-semibold">
              <s className="text-[#64748B] font-normal">{t("mock.row1Old")}</s>
              <span className="text-[#34D399]"> → {t("mock.row1New")}</span>
            </span>
          </div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-[#8B98AC]">{t("mock.sat")}</span>
            <span className="font-semibold">
              <s className="text-[#64748B] font-normal">{t("mock.row2Old")}</s>
              <span className="text-[#34D399]"> → {t("mock.row2New")}</span>
            </span>
          </div>
          <div className="flex gap-2 pt-1">
            <span className="flex-1 text-center bg-[#F97316] text-[#0B1220] text-[13px] font-extrabold px-3 py-2 rounded-[10px]">
              {t("mock.apply")}
            </span>
            <span className="text-center border border-[#2A3A55] text-[#B7C2D2] text-[13px] font-bold px-3 py-2 rounded-[10px]">
              {t("mock.notNow")}
            </span>
          </div>
        </div>
        {/* Fits the 560px sm frame but clips in the 520px one — hide below sm. */}
        <div className="hidden sm:block self-start max-w-[90%] bg-[#131C2B] border border-[#1E2A3D] text-[#D7DFEA] text-[13px] leading-snug px-3.5 py-2.5 rounded-[16px] rounded-bl-[4px]">
          {t("mock.reply2")}
        </div>
      </div>
      <div className="px-3.5 pb-4">
        <div className="flex items-center justify-between border border-[#2A3A55] rounded-[12px] px-3.5 py-2.5">
          <span className="text-[13px] text-[#64748B]">{t("mock.inputPlaceholder")}</span>
          <span className="w-7 h-7 rounded-[9px] bg-[#F97316] flex items-center justify-center">
            <ArrowRight size={14} className="text-[#0B1220]" />
          </span>
        </div>
      </div>
    </div>
  );
}

// Purpose-built "live tracking" illustration for the third feature card — stat
// tiles plus a stylised route with a LIVE badge. Intentionally not a screenshot.
function LiveTrackerMock() {
  const { t } = useTranslation("marketing");
  const tiles = [
    { v: "3.42", l: t("mock.tiles.km"), c: "#F1F5F9" },
    { v: "21:08", l: t("mock.tiles.time"), c: "#F1F5F9" },
    { v: "6:11", l: t("mock.tiles.pace"), c: "#F1F5F9" },
    { v: "148", l: t("mock.tiles.bpm"), c: "#F87171" },
  ];
  return (
    <div className="h-[280px] sm:h-[300px] overflow-hidden border-b border-[#1E2A3D] bg-[#0B1220]">
      <div className="grid grid-cols-4 gap-2 px-4 pt-4 pb-3">
        {tiles.map((tile) => (
          <div key={tile.l} className="bg-[#131C2B] rounded-[12px] py-2.5 flex flex-col items-center gap-0.5">
            <span className="font-extrabold text-[17px]" style={{ color: tile.c }}>
              {tile.v}
            </span>
            <span className="text-[#8B98AC] text-[9px] font-bold tracking-[1px]">{tile.l}</span>
          </div>
        ))}
      </div>
      <div className="relative mx-4 h-[200px] rounded-[14px] overflow-hidden bg-[#10192A]">
        <svg width="100%" height="100%" viewBox="0 0 360 200" fill="none" preserveAspectRatio="xMidYMid slice">
          <line x1="60" y1="0" x2="60" y2="200" stroke="#1B2740" strokeWidth="6" />
          <line x1="150" y1="0" x2="150" y2="200" stroke="#1B2740" strokeWidth="4" />
          <line x1="260" y1="0" x2="260" y2="200" stroke="#1B2740" strokeWidth="6" />
          <line x1="0" y1="50" x2="360" y2="50" stroke="#1B2740" strokeWidth="4" />
          <line x1="0" y1="130" x2="360" y2="130" stroke="#1B2740" strokeWidth="6" />
          <rect x="290" y="60" width="70" height="55" rx="4" fill="#14243A" opacity="0.6" />
          <rect x="10" y="145" width="120" height="55" rx="4" fill="#12301F" opacity="0.35" />
          <polyline
            points="40,170 60,130 110,130 150,90 210,90 260,50 300,50 322,78"
            stroke="#F97316"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="40" cy="170" r="6" fill="#34D399" />
        </svg>
        <div
          className="absolute w-3.5 h-3.5 rounded-full bg-[#F97316] border-[3px] border-[#FDBA74]"
          style={{ left: `${(322 / 360) * 100}%`, top: 78, margin: "-7px 0 0 -7px", boxShadow: "0 0 0 6px rgba(249,115,22,0.25)" }}
        />
        <div className="absolute right-2.5 bottom-2.5 bg-[rgba(11,18,32,0.85)] border border-[#2A3A55] text-[#B7C2D2] text-[10px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#F97316]" />
          {t("mock.live")}
        </div>
      </div>
    </div>
  );
}

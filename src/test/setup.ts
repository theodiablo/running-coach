import "@testing-library/jest-dom/vitest";
import { initI18n } from "../i18n";

// English strings are the test fixture: init i18n once so every component and
// t()-backed helper renders the same text the assertions were written against.
initI18n("en");

// jsdom has no layout, so window.scrollTo logs "Not implemented" for anything
// that scrolls the page (the header's back-to-Home). Stub it to a no-op.
window.scrollTo = () => {};

// jsdom has no matchMedia; stub a "no reduced motion" default so
// usePrefersReducedMotion (and anything media-query driven) works under test.
// Individual tests can override window.matchMedia to exercise the other branch.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

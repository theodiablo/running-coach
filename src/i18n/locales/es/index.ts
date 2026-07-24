// One JSON file per top-level key section (t("plan.…") lives in plan.json).
// Keep en/es/fr structurally identical; a key-parity test enforces it.
import common from "./common.json";
import nav from "./nav.json";
import dashboard from "./dashboard.json";
import plan from "./plan.json";
import styles from "./styles.json";
import races from "./races.json";
import coach from "./coach.json";
import tracker from "./tracker.json";
import log from "./log.json";
import progress from "./progress.json";
import badges from "./badges.json";
import settings from "./settings.json";
import onboarding from "./onboarding.json";
import login from "./login.json";
import app from "./app.json";
import routeFinder from "./routeFinder.json";

export default {
  common, nav, dashboard, plan, styles, races, coach, tracker,
  log, progress, badges, settings, onboarding, login, app, routeFinder,
};

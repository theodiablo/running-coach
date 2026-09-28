// URLs reach PostHog on every automatic pageview. Query strings and fragments
// carry auth material (`?code=`, a recovery link's `#access_token=`) and the
// watch page's path IS its authorization, so neither may leave the device.

const URL_PROP = /(url|pathname|referrer)$/i;

export function scrubUrl(value: string): string {
  const redact = (path: string) => path.replace(/\/watch\/[^/?#]+/g, "/watch/:token");
  try {
    const u = new URL(value);
    return `${u.origin}${redact(u.pathname)}`;
  } catch {
    return redact(value.split(/[?#]/)[0]);
  }
}

function scrubProps(props: Record<string, unknown> | undefined) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" && URL_PROP.test(k)) props[k] = scrubUrl(v);
  }
}

type CaptureLike = { properties?: Record<string, unknown>; $set?: Record<string, unknown>; $set_once?: Record<string, unknown> };

export function scrubEvent<T extends CaptureLike | null>(event: T): T {
  if (!event) return event;
  scrubProps(event.properties);
  scrubProps(event.$set);
  scrubProps(event.$set_once);
  return event;
}

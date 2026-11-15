// The race-catalogue crawler (scripts/race-crawler/, docs/race-crawler.md): parsers on fixtures shaped like the
// real pages, the matcher, and the curated policy.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM script module.
import { parseDistances, countryCode, distinctiveTokens, hostOf } from "../scripts/race-crawler/text.mjs";
// @ts-expect-error — plain ESM script module.
import { classify, matchRace, mergeSources, worthProposing } from "../scripts/race-crawler/classify.mjs";
// @ts-expect-error — plain ESM script module.
import * as rts from "../scripts/race-crawler/sources/rockthesport.mjs";
// @ts-expect-error — plain ESM script module.
import * as rl from "../scripts/race-crawler/sources/runninglife.mjs";

const TODAY = "2026-11-15";
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const flight = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;

const RTS_PAGE =
  "<html><head>" +
  ld({ "@context": "https://schema.org", "@type": "WebSite", name: "RockTheSport" }) +
  ld({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: "XXVI Media Maratón San Sebastián 2027",
    startDate: "2027-04-04T09:30:00.0000000",
    eventStatus: "https://schema.org/EventScheduled",
    sport: "running",
    location: { "@type": "Place", geo: { latitude: "43.318334", longitude: "-1.9812313" } },
    organizer: { "@type": "Organization", url: "www.mediadonosti.com" },
  }) +
  "</head><body>" +
  flight(
    '{"tariffNames":{"1":"CARRERA 10KM","2":"MEDIO MARATÓN 21KM","3":"Elite MEDIO MARATÓN 21KM"},' +
      '"location":{"city":"Donostia-San Sebastián","province":"Gipuzkoa","provinceId":38,"country":"Spain",' +
      '"countryId":65,"latitude":43.318334,"longitude":-1.9812313},"sport":"running","subsports":["10km","half marathon"]}',
  ) +
  "</body></html>";

const rlEvent = (name: string, date: string, description: string, country = "Ireland") => ({
  "@type": "SportsEvent",
  name,
  description,
  url: `https://running.life/en/event/${name.toLowerCase().replace(/\W+/g, "-")}`,
  startDate: date,
  eventStatus: "https://schema.org/EventScheduled",
  location: {
    "@type": "Place",
    address: { addressLocality: "Dublin", addressCountry: country },
    geo: { latitude: 53.34, longitude: -6.26 },
  },
});

const RL_LISTING =
  ld({
    "@type": "ItemList",
    itemListElement: [
      { "@type": "ListItem", position: 1, item: rlEvent("Raheny 5", "2027-01-31", "A five mile road race in Raheny.") },
      {
        "@type": "ListItem",
        position: 2,
        item: rlEvent("Dublin Marathon", "2027-10-24", "The Dublin Marathon will take place in Dublin. You can run 42 kilometers."),
      },
    ],
  }) + '<a href="https://running.life/running-calendar/ireland?page=2">2</a><a href="?page=14">14</a>';

const race = (over: Record<string, unknown>) => ({
  slug: "x",
  name: "X",
  city: "",
  country: "ES",
  lat: null,
  lng: null,
  distances: [],
  url: "",
  ...over,
});

const CATALOGUE = {
  races: [
    race({
      slug: "media-maraton-donostia",
      name: "Media Maratón de San Sebastián",
      city: "San Sebastián",
      lat: 43.3166,
      lng: -1.9817,
      distances: [21.1],
      url: "https://www.mediadonosti.com/",
    }),
    race({
      slug: "san-silvestre-vallecana",
      name: "San Silvestre Vallecana",
      city: "Madrid",
      lat: 40.45,
      lng: -3.69,
      distances: [10],
    }),
    race({ slug: "dublin-marathon", name: "Irish Life Dublin Marathon", city: "Dublin", country: "IE", lat: 53.34, lng: -6.26, distances: [42.2], url: "https://irishlifedublinmarathon.ie/" }),
    race({ slug: "media-maraton-castellon", name: "Media Maratón de Castellón", city: "Castellón", lat: 39.98, lng: -0.04, distances: [21.1] }),
  ],
  editions: [
    { id: "dublin-marathon-2026-10-25", race_slug: "dublin-marathon", date: "2026-10-25", distance_km: 42.2 },
    { id: "media-maraton-donostia-2027-04-11", race_slug: "media-maraton-donostia", date: "2027-04-11", distance_km: 21.1 },
  ],
};

const candidate = (over: Record<string, unknown>) => ({
  source: "runninglife",
  sourceKey: "k",
  url: "https://running.life/en/event/k",
  firstHand: false,
  name: "Some Race",
  date: "2027-03-07",
  city: "Madrid",
  region: "",
  country: "ES",
  lat: 40.42,
  lng: -3.7,
  distances: [21.1],
  running: true,
  sport: "running",
  status: "scheduled",
  organiserUrl: "",
  text: "",
  ...over,
});

describe("parseDistances", () => {
  it.each([
    ["CARRERA 10KM | MEDIO MARATÓN 21KM", [10, 21.1]],
    ["You can run between 7 and 13 kilometers.", [7, 13]],
    ["Mitja Marató de Lleida", [21.1]],
    ["Semi-marathon et 10 km", [10, 21.1]],
    ["John Treacy Dungarvan 10 Mile", [16.1]],
    ["Trail des Truffières 49 km", [49]],
    ["42,195 km", [42.2]],
    ["Ultra marathon 100K", [100]],
    ["Raheny 5", []],
  ])("%s", (text, km) => expect(parseDistances(text)).toEqual(km));
});

describe("text helpers", () => {
  it("maps country names to ISO alpha-2, never the reserved FX/UK", () => {
    expect(["France", "United Kingdom", "Ireland", "Spain", "UK", "Narnia"].map(countryCode)).toEqual([
      "FR",
      "GB",
      "IE",
      "ES",
      "GB",
      "",
    ]);
  });
  it("keeps only the words that tell one race from another", () => {
    expect(distinctiveTokens("XXVI Media Maratón San Sebastián 2027")).toEqual(["sebastian"]);
    expect(distinctiveTokens("42 Carrera Popular CaixaBank Villa de Aranjuez")).toEqual(["caixabank", "aranjuez"]);
  });
  it("reads a host from a scheme-less organiser URL", () => {
    expect(hostOf("www.mediadonosti.com")).toBe("mediadonosti.com");
    expect(hostOf("")).toBe("");
  });
});

describe("rockthesport", () => {
  it("discovers sitemap URLs changed since a day", () => {
    const xml =
      "<urlset><url><loc>https://web.rockthesport.com/es/event/a</loc><lastmod>2026-11-14T10:00:00Z</lastmod></url>" +
      "<url><loc>https://web.rockthesport.com/es/event/b</loc><lastmod>2026-10-01T10:00:00Z</lastmod></url></urlset>";
    expect(rts.discover(xml, "2026-11-08").map((u: { url: string }) => u.url)).toEqual([
      "https://web.rockthesport.com/es/event/a",
    ]);
  });
  it("parses an event page", () => {
    const c = rts.parse(RTS_PAGE, "https://web.rockthesport.com/es/event/xxvi-media-maraton-san-sebastian-2027");
    expect(c).toMatchObject({
      sourceKey: "xxvi-media-maraton-san-sebastian-2027",
      firstHand: true,
      date: "2027-04-04",
      city: "Donostia-San Sebastián",
      country: "ES",
      lat: 43.318334,
      distances: [10, 21.1],
      running: true,
      status: "scheduled",
      organiserUrl: "www.mediadonosti.com",
    });
  });
  it("returns null for a page with no event", () => {
    expect(rts.parse("<html></html>", "https://web.rockthesport.com/es/event/x")).toBeNull();
  });
});

describe("runninglife", () => {
  it("parses a calendar page and its page count", () => {
    const { events, lastPage } = rl.parseListing(RL_LISTING);
    expect(lastPage).toBe(14);
    expect(events.map((e: { name: string; distances: number[]; country: string }) => [e.name, e.distances, e.country])).toEqual([
      ["Raheny 5", [], "IE"],
      ["Dublin Marathon", [42.2], "IE"],
    ]);
  });
  it("reads the organiser link off an event page", () => {
    const html =
      ld(rlEvent("Dublin Marathon", "2027-10-24", "Full description.")) +
      '<a href="https://irishlifedublinmarathon.ie/" target="_blank" data-out="website" data-out-race="1">Website</a>';
    expect(rl.parseEvent(html)).toEqual({ description: "Full description.", organiserUrl: "https://irishlifedublinmarathon.ie/" });
  });
});

describe("matchRace", () => {
  it("matches on the organiser's own site", () => {
    const c = rts.parse(RTS_PAGE, "https://web.rockthesport.com/es/event/xxvi-media-maraton-san-sebastian-2027");
    expect(matchRace(c, CATALOGUE.races)).toMatchObject({ kind: "match", slug: "media-maraton-donostia" });
  });
  it("does not take another San Silvestre in the same area for the Vallecana", () => {
    const c = candidate({ name: "San Silvestre de Alcorcón", city: "Alcorcón", lat: 40.35, lng: -3.83, distances: [10] });
    expect(matchRace(c, CATALOGUE.races).kind).toBe("none");
  });
  it("matches a '<kind> <town>' name to the same kind in the same town", () => {
    const c = candidate({ name: "Media Maratón de Castelló", city: "Castelló de la Plana", lat: 39.99, lng: -0.05 });
    expect(matchRace(c, CATALOGUE.races)).toMatchObject({ kind: "match", slug: "media-maraton-castellon" });
  });
  it("matches a bare name to its sponsored catalogue name, but not a different kind of race", () => {
    const dublin = { city: "Dublin", country: "IE", lat: 53.34, lng: -6.26 };
    expect(matchRace(candidate({ ...dublin, name: "Dublin Marathon", distances: [42.2] }), CATALOGUE.races)).toMatchObject({
      kind: "match",
      slug: "dublin-marathon",
    });
    expect(matchRace(candidate({ ...dublin, name: "Dublin Half Marathon", distances: [] }), CATALOGUE.races).kind).toBe("none");
  });
  it("does not take a half in a nearby town for the catalogue's '<kind> <town>' race", () => {
    const elche = race({ slug: "media-maraton-elche", name: "Media Maratón de Elche", city: "Elche", lat: 38.27, lng: -0.7, distances: [21.1] });
    const c = candidate({ name: 'Medio Maratón Nacional "Ciudad de Orihuela"', city: "Orihuela", lat: 38.08, lng: -0.94 });
    expect(matchRace(c, [elche]).kind).toBe("none");
  });
  it("leaves a name-only match with no distance for review", () => {
    const templiers = race({ slug: "templiers", name: "Festival des Templiers", city: "Millau", country: "FR", lat: 44.1, lng: 3.08, distances: [80] });
    const c = candidate({ name: "Hivernale des Templiers", city: "Millau", country: "FR", lat: 44.1, lng: 3.08, distances: [] });
    expect(matchRace(c, [templiers]).kind).toBe("ambiguous");
  });
  it("never matches across countries or far away", () => {
    expect(matchRace(candidate({ name: "San Silvestre Vallecana", country: "FR" }), CATALOGUE.races).kind).toBe("none");
    expect(matchRace(candidate({ name: "San Silvestre Vallecana", lat: 41.4, lng: 2.17 }), CATALOGUE.races).kind).toBe("none");
  });
});

describe("classify", () => {
  it("proposes a new edition of a catalogue race", () => {
    const c = candidate({ name: "Dublin Marathon", city: "Dublin", country: "IE", lat: 53.34, lng: -6.26, date: "2027-10-24", distances: [42.2] });
    expect(classify(c, CATALOGUE, TODAY)).toMatchObject({ verdict: "newEdition", slug: "dublin-marathon" });
  });
  it("flags a moved date instead of a second edition", () => {
    const c = rts.parse(RTS_PAGE, "https://web.rockthesport.com/es/event/xxvi-media-maraton-san-sebastian-2027");
    expect(classify(c, CATALOGUE, TODAY)).toMatchObject({ verdict: "dateChange", previousDate: "2027-04-11" });
  });
  it("knows an edition the catalogue already has", () => {
    const c = candidate({ name: "Media Maratón San Sebastián", city: "San Sebastián", lat: 43.32, lng: -1.98, date: "2027-04-11" });
    expect(classify(c, CATALOGUE, TODAY).verdict).toBe("known");
  });
  it.each([
    [{ distances: [5, 8] }, "under 10 km"],
    [{ running: false }, "not running"],
    [{ name: "Duatlón Cross Manzanares" }, "not running"],
    [{ status: "cancelled" }, "cancelled"],
    [{ date: "2026-11-01" }, "past"],
    [{ name: "Virtual Half" }, "virtual"],
    [{ distances: [10, 15] }, "new race under half marathon"],
    [{ distances: [] }, "distance unknown"],
  ])("drops %o: %s", (over, why) => {
    expect(classify(candidate({ name: "Carrera del Puerto", ...over }), CATALOGUE, TODAY)).toMatchObject({ verdict: "dropped", why });
  });
  it("proposes a new race of a half marathon or longer, flagging what needs checking", () => {
    const v = classify(candidate({ name: "Carrera del Puerto", date: "2027-03-10" }), CATALOGUE, TODAY);
    expect(v).toMatchObject({ verdict: "newRace", distances: [21.1], minor: true });
    expect(v.flags).toEqual(expect.arrayContaining(["second-hand date", "weekday"]));
  });
});

describe("mergeSources", () => {
  it("folds the same new race from two sources into one, first-hand first, and keeps it", () => {
    const a = { verdict: "newRace", distances: [21.1], flags: [], minor: true, candidate: candidate({ name: "Mitja Marató de Ripoll" }) };
    const b = {
      verdict: "newRace",
      distances: [21.1],
      flags: [],
      minor: false,
      candidate: candidate({ source: "rockthesport", firstHand: true, name: "XII Mitja Marató Ripoll 2027" }),
    };
    const merged = mergeSources([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].candidate.source).toBe("rockthesport");
    expect(merged[0].alsoIn).toEqual([{ source: "runninglife", url: a.candidate.url }]);
    expect(worthProposing(merged[0])).toBe(true);
  });
  it("drops a sub-marathon new race only an aggregator lists", () => {
    expect(worthProposing({ minor: true })).toBe(false);
  });
});

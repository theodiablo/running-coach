// The race-catalogue crawler (scripts/race-crawler/, docs/race-crawler.md): parsers on fixtures shaped like the
// real pages, the matcher, and the curated policy.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM script module.
import { parseDistances, countryCode, distinctiveTokens, hostOf } from "../scripts/race-crawler/text.mjs";
// @ts-expect-error — plain ESM script module.
import { classify, matchRace, mergeSources, worthProposing } from "../scripts/race-crawler/classify.mjs";
// @ts-expect-error — plain ESM script module.
import { buildSql, cleanCity, cleanName, plan, webUrl } from "../scripts/race-crawler/apply.mjs";
// @ts-expect-error — plain ESM script module.
import * as rts from "../scripts/race-crawler/sources/rockthesport.mjs";
// @ts-expect-error — plain ESM script module.
import * as rl from "../scripts/race-crawler/sources/runninglife.mjs";
// @ts-expect-error — plain ESM script module.
import * as far from "../scripts/race-crawler/sources/findarace.mjs";
// @ts-expect-error — plain ESM script module.
import * as ats from "../scripts/race-crawler/sources/atssport.mjs";

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

describe("parseDistances: miles in Spanish and French", () => {
  it.each([
    ["IX CROSS 5 MILLAS VILLAMANTILLA", [8]],
    ["Les 10 milles de Paris", [16.1]],
  ])("%s", (text, kms) => expect(parseDistances(text)).toEqual(kms));
});

describe("parseDistances: not race distances", () => {
  it.each([
    ["Relais 4x10km", []],
    ["Duo 2 x 12 km", []],
    ["Relais 4x10km et 25 km", [25]],
    ["Allure 10 km/h", []],
  ])("%s", (text, kms) => expect(parseDistances(text)).toEqual(kms));
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
    ["Recaptació íntegra a MARATÓTV3", []],
    ["MARATO I MITJA MARATO RELLEUS", [21.1, 42.2]],
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
  it("reads a fare's distance from its description when its name has none", () => {
    const page = RTS_PAGE.replace(
      "</body>",
      flight('{"publicName":"MIUT LEGEND","description":"110 KMS 7200D+","active":true},' +
        '{"publicName":"MIUT MARATHON","description":"40 KMS 1500D+","active":true}') + "</body>",
    );
    const { distances } = rts.parse(page, "https://web.rockthesport.com/es/event/miut");
    expect(distances).toEqual(expect.arrayContaining([40, 110]));
    expect(distances).not.toContain(42.2);
  });
  it("takes no distance from a walk, kids', relay or bike fare", () => {
    const page = RTS_PAGE.replace(
      "</body>",
      flight('{"publicName":"Marcha 12K","description":"","active":true},' +
        '{"publicName":"Niños 10k","description":"","active":true},' +
        '{"publicName":"Relevos 4x10km","description":"","active":true},' +
        '{"publicName":"Carrera 15K","description":"","active":true}') + "</body>",
    );
    const { distances } = rts.parse(page, "https://web.rockthesport.com/es/event/x");
    expect(distances).toContain(15);
    expect(distances).not.toContain(12);
  });
  it("never reads a filtered-out fare back from the fare names list", () => {
    const page =
      ld({ "@type": "SportsEvent", name: "Marcha Solidaria", startDate: "2027-04-04T09:30:00", sport: "running" }) +
      flight('{"publicName":"Marcha 12K","description":"","active":true}') +
      flight('"tariffNames":{"a":"Marcha 12K"}');
    expect(rts.parse(page, "https://web.rockthesport.com/es/event/x").distances).toEqual([]);
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

const crumbs = (...names: string[]) =>
  ld({
    "@type": "BreadcrumbList",
    itemListElement: names.map((name, i) => ({ "@type": "ListItem", position: i + 1, name })),
  });
const farEvent = (over: Record<string, unknown> = {}) =>
  ld({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: "Hampton Court Palace Running Festival Presented by Voltarol",
    startDate: "2027-10-17T09:00:00+01:00",
    endDate: "2027-10-17",
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    description: "Run a flat 10K or half marathon amid palace history.",
    organizer: { "@type": "Organization", url: "https://findarace.com/runthroughevents" },
    location: {
      "@type": "Place",
      name: "East Molesey, Surrey",
      address: "Hampton Court Palace, Molesey, East Molesey KT8 9BN, UK",
      geo: { "@type": "GeoCoordinates", latitude: 51.4046971, longitude: -0.3417534 },
    },
    offers: [{ "@type": "Offer", name: "Half Marathon" }, { "@type": "Offer", name: "10k" }],
    ...over,
  });
const FAR_URL = "https://findarace.com/events/hampton-court-palace-half-marathon/17th-october-2027";

describe("findarace", () => {
  it("parses an event page: offers for distances, the address for town and country", () => {
    const c = far.parse(farEvent() + crumbs("Home", "Running", "Half Marathon", "Hampton Court"), FAR_URL);
    expect(c).toMatchObject({
      sourceKey: "hampton-court-palace-half-marathon",
      firstHand: false,
      name: "Hampton Court Palace Running Festival",
      date: "2027-10-17",
      city: "East Molesey",
      country: "GB",
      lat: 51.4046971,
      distances: [10, 21.1],
      running: true,
      organiserUrl: "",
    });
  });
  it("keys an event by its slug, so its edition URL and its event URL are one ledger row", () => {
    const html = farEvent() + crumbs("Home", "Running", "X");
    expect(far.parse(html, "https://findarace.com/events/hampton-court-palace-half-marathon").sourceKey).toBe(
      far.parse(html, FAR_URL).sourceKey,
    );
  });
  it("leaves other sports and online events out of running", () => {
    expect(far.parse(farEvent() + crumbs("Home", "Walk or Run", "X"), FAR_URL).running).toBe(true);
    expect(far.parse(farEvent() + crumbs("Home", "Walking", "X"), FAR_URL).running).toBe(false);
    expect(far.parse(farEvent() + crumbs("Home", "Duathlon", "Sprint", "X"), FAR_URL).running).toBe(false);
    const online = farEvent({ eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode" });
    expect(far.parse(online + crumbs("Home", "Running", "X"), FAR_URL).running).toBe(false);
    // A short trail names no sport: the name is left to classify.
    expect(far.parse(farEvent() + crumbs("Home", "Leeds Half Marathon"), FAR_URL).running).toBe(true);
  });
  it("falls back to the name, then the description, for distances", () => {
    const noKm = farEvent({ name: "Colchester Half Marathon", offers: [{ name: "General Entry" }] });
    expect(far.parse(noKm, FAR_URL).distances).toEqual([21.1]);
    const bare = farEvent({ name: "Squirrel Challenge", offers: [] });
    expect(far.parse(bare, FAR_URL).distances).toEqual([10, 21.1]);
  });
  it("reads town and country off UK, Irish and cut-short addresses", () => {
    expect(far.addressParts("Graves Park, Sheffield, S8 8LL, United Kingdom")).toEqual({ city: "Sheffield", country: "GB" });
    expect(far.addressParts("Durham Amateur Rowing Club, Durham, DH1 3, UK")).toEqual({ city: "Durham", country: "GB" });
    expect(far.addressParts("Custom House Quay, Dublin 1, D01 F5P2, Ireland")).toEqual({ city: "Dublin 1", country: "IE" });
    expect(far.addressParts("Barcelona")).toEqual({ city: "", country: "" });
  });
  it("never takes a county or a UK nation for the town", () => {
    expect(far.addressParts("Ware, Hertfordshire, SG12 9AA, United Kingdom")).toEqual({ city: "Ware", country: "GB" });
    expect(far.addressParts("Seaford, E Sussex, BN25 1AA, England")).toEqual({ city: "Seaford", country: "GB" });
    expect(far.addressParts("Ashton Court, Bristol, England, United Kingdom")).toEqual({ city: "Bristol", country: "GB" });
    expect(far.addressParts("Hyde Park, London, W2 2UH, UK")).toEqual({ city: "London", country: "GB" });
  });
  it("returns null for a page with no event", () => {
    expect(far.parse("<html></html>", FAR_URL)).toBeNull();
  });
});

const atsCourse = (name: string, type: string) =>
  `<a data-toggle="collapse" href="#parcours-1">\n ${name} </a></h4></div><div class="panel-body">` +
  `<p><strong>Départ :</strong> <span class="text-theme">Samedi</span></p>` +
  `<p><strong>Distance :</strong> <span class="text-theme">${type}</span></p></div>`;
const ATS_URL = "https://ats-sport.com/epreuve.php?id_epreuve=9660";
const atsPage = (...courses: string[]) =>
  ld({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: "Semi-Marathon de SETE ",
    startDate: "2027-10-02T00:00:00",
    endDate: "2027-10-02",
    eventStatus: "https://schema.org/EventScheduled",
    url: ATS_URL,
    location: { "@type": "Place", address: { addressLocality: "St Girons", addressRegion: "09", addressCountry: "France" } },
  }) + courses.join("");

describe("atssport", () => {
  it("discovers event pages only", () => {
    const xml =
      "<urlset><url><loc>https://ats-sport.com/epreuve.php?id_epreuve=9660</loc><lastmod>2026-11-14</lastmod></url>" +
      "<url><loc>https://ats-sport.com/resultats_epreuve.php?epreuve=8035&amp;parcours=20451</loc><lastmod>2026-11-14</lastmod></url>" +
      "<url><loc>https://ats-sport.com/epreuve.php?id_epreuve=1</loc><lastmod>2025-01-01</lastmod></url></urlset>";
    expect(ats.discover(xml, "2026-11-01").map((u: { url: string }) => u.url)).toEqual([ATS_URL]);
  });
  it("keeps the running courses, with a distance from the name or the course type", () => {
    const c = ats.parse(
      atsPage(
        atsCourse("Semi Marathon de  Sète", "Semi Marathon"),
        atsCourse("le 10km", "Course sur route"),
        atsCourse("Trail des Salines 23Km, 1500 D+", "Trail"),
        atsCourse("Marche Nordique 12 km", "Marche nordique"),
        atsCourse("Courses enfants 1 km", "Course enfant"),
        atsCourse("La Gravel 63 kms (ANNULE)", "Trail"),
      ),
      ATS_URL,
    );
    expect(c).toMatchObject({
      sourceKey: "9660",
      firstHand: true,
      name: "Semi-Marathon de SETE",
      date: "2027-10-02",
      city: "St Girons",
      region: "09",
      country: "FR",
      lat: null,
      distances: [10, 21.1, 23],
      running: true,
    });
  });
  it("leaves out bike, dog, walk and kids' courses whatever their type", () => {
    const c = ats.parse(
      atsPage(
        atsCourse("XC 45 km", "Cross-country VTT"),
        atsCourse("Cani 25 km", "Cani-cross"),
        atsCourse("Rando 30 km", "Rando semi-nocturne"),
        atsCourse("Trail enfants 2 km", "Trail"),
        atsCourse("Course pédestre 15 km", "Course pédestre"),
        atsCourse("Trail du Canigou 42 km", "Trail"),
        atsCourse("Foulées de Marcheprime 12 km", "Course sur route"),
      ),
      ATS_URL,
    );
    expect(c.distances).toEqual([12, 15, 42.2]);
  });
  it("doubts a date its own page's text does not name the year of", () => {
    const page = (description: string) =>
      ld({
        "@type": "SportsEvent",
        name: "La Ronde de Saint-Georges",
        startDate: "2027-05-09T00:00:00",
        description,
        location: { address: { addressLocality: "Saint-Georges-d'Orques", addressRegion: "34", addressCountry: "France" } },
      }) + atsCourse("11 km", "Course sur route");
    expect(ats.parse(page("La 37e édition aura lieu le dimanche 10 mai 2026."), ATS_URL).dateDoubt).toBe(true);
    expect(ats.parse(page("La 38e édition aura lieu le dimanche 9 mai 2027."), ATS_URL).dateDoubt).toBe(false);
    expect(ats.parse(page("Départ aux arènes."), ATS_URL).dateDoubt).toBe(false);
    expect(ats.parse(page("28 km : nés en 2005 et avant. 17 km : nés en 2009."), ATS_URL).dateDoubt).toBe(false);
    expect(ats.parse(page("Une course qui existe depuis 2012."), ATS_URL).dateDoubt).toBe(false);
    expect(ats.parse(page("Le samedi 25 avril 2025 à partir de 9h."), ATS_URL).dateDoubt).toBe(true);
  });
  it("is not running when no course is", () => {
    const c = ats.parse(atsPage(atsCourse("Format S Solo", "Swimrun"), atsCourse("128 KMS", "Cyclotourisme")), ATS_URL);
    expect(c.running).toBe(false);
  });
  it("looks the town up by its official name, in its département, and only trusts a same-name commune", () => {
    const c = ats.parse(atsPage(atsCourse("10 km", "Course sur route")), ATS_URL);
    const q = new URL(ats.communeQuery(c));
    expect(q.host).toBe("geo.api.gouv.fr");
    expect(q.searchParams.get("nom")).toBe("Saint Girons");
    expect(q.searchParams.get("codeDepartement")).toBe("09");
    const found = [
      { nom: "Vielle-Saint-Girons", centre: { coordinates: [-1.32, 43.94] } },
      { nom: "Saint-Girons", centre: { coordinates: [1.1591, 42.9681] } },
    ];
    expect(ats.pickCommune(found, "St Girons")).toEqual({ lat: 42.9681, lng: 1.1591 });
    expect(ats.pickCommune([found[0]], "St Girons")).toBeNull();
    const twins = [
      { nom: "Saint-Denis", centre: { coordinates: [2.35, 48.93] } },
      { nom: "Saint-Denis", centre: { coordinates: [55.45, -20.88] } },
    ];
    expect(ats.pickCommune(twins, "Saint Denis")).toBeNull();
    expect(ats.pickCommune(null, "St Girons")).toBeNull();
    expect(ats.communeQuery({ ...c, country: "ES" })).toBeNull();
  });
});

describe("matchRace", () => {
  it("still knows a French race whose only word is generic, distance named or not", () => {
    const vannes = race({ slug: "les-foulees-de-vannes", name: "Les Foulées de Vannes", city: "Vannes", country: "FR", lat: 47.65, lng: -2.76, distances: [10] });
    for (const name of ["Foulées de Vannes 10 km", "Foulées de Vannes 10K", "36èmes Foulées de Vannes"]) {
      const c = candidate({ source: "atssport", firstHand: true, name, city: "Vannes", country: "FR", lat: 47.651, lng: -2.761, distances: [10] });
      expect(matchRace(c, [vannes])).toMatchObject({ kind: "match", slug: "les-foulees-de-vannes" });
    }
  });
  it("keeps two races apart when only a number differs", () => {
    const five = race({ slug: "trail-5-cims", name: "Trail 5 Cims Getafe", city: "Getafe", lat: 40.3, lng: -3.73, distances: [30] });
    const c = candidate({ source: "rockthesport", firstHand: true, name: "Trail 3 Cims Getafe", city: "Getafe", lat: 40.3, lng: -3.73, distances: [30] });
    expect(matchRace(c, [five]).kind).not.toBe("match");
  });
  it("does not call two French races the same for a shared 'foulées'", () => {
    const montbazin = race({
      slug: "36emes-foulees-des-droits-de-l-homme",
      name: "36èmes foulées des droits de l'Homme",
      city: "Montbazin",
      country: "FR",
      lat: 43.5163,
      lng: 3.6967,
      distances: [12],
    });
    const poussan = candidate({
      source: "atssport",
      firstHand: true,
      name: "TRAIL DES FOULEES POUSSANAISES (7ème édition)",
      city: "Poussan",
      country: "FR",
      lat: 43.4976,
      lng: 3.6623,
      distances: [12.5, 21.1],
    });
    expect(matchRace(poussan, [montbazin]).kind).toBe("none");
  });
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
  it("leaves a source name with words of its own for review, even in the same town", () => {
    const cardiff = race({ slug: "cardiff-half", name: "Cardiff Half Marathon", city: "Cardiff", country: "GB", lat: 51.48, lng: -3.18, distances: [21.1] });
    const c = candidate({ name: "The Cardiff Half Marathon Winter Warmer Run", city: "Cardiff", country: "GB", lat: 51.48, lng: -3.18 });
    expect(matchRace(c, [cardiff]).kind).toBe("ambiguous");
  });
  it("tells a trail marathon from the road marathon of the same town, and matches it to itself", () => {
    const where = { city: "Llanberis", country: "GB", lat: 53.12, lng: -4.13 };
    const road = race({ ...where, slug: "marathon-eryri", name: "Marathon Eryri", distances: [42.2] });
    const trail = race({ ...where, slug: "snowdonia-marathon", name: "Snowdonia Trail Marathon Eryri", distances: [43.9] });
    const c = candidate({ ...where, name: "Snowdonia Trail Marathon Eryri", distances: [42.2] });
    expect(matchRace(c, [road, trail])).toMatchObject({ kind: "match", slug: "snowdonia-marathon" });
  });
  it("knows a town-and-a-generic-word name as itself, whatever distances the page lists today", () => {
    const sastago = race({ slug: "trail-sastago", name: "Trail Sástago", city: "Sástago", lat: 41.32, lng: -0.35, distances: [25] });
    const c = candidate({ name: "V Trail Sástago 2027", city: "Sástago", lat: 41.32, lng: -0.35, distances: [13, 22] });
    expect(matchRace(c, [sastago])).toMatchObject({ kind: "match", slug: "trail-sastago" });
  });
  it("never takes two races for one because only the town is left of their names", () => {
    const where = { city: "Polop", lat: 38.62, lng: -0.13 };
    const copa = race({ ...where, slug: "copa-foo-polop", name: "Copa Foo, Polop", distances: [21.1] });
    const c = candidate({ ...where, name: "Liga Bar, Polop", distances: [10] });
    expect(matchRace(c, [copa]).kind).toBe("none");
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
    [{ distances: [] }, "distance unknown"],
    [{ date: "2027-02-30" }, "invalid date"],
    [{ name: "15. AzkoitiAzpeitia lasterketa motza 8,06km", distances: [21.1] }, "under 10 km"],
    [{ name: "29a Marxa del Terme" }, "not running"],
    [{ name: "Carrera Infantil de la Primavera" }, "not running"],
  ])("drops %o: %s", (over, why) => {
    expect(classify(candidate({ name: "Carrera del Puerto", ...over }), CATALOGUE, TODAY)).toMatchObject({ verdict: "dropped", why });
  });
  it("flags a multi-day event, whose first day need not be race day", () => {
    const v = classify(candidate({ name: "Carrera del Puerto", date: "2027-07-10", endDate: "2027-07-11" }), CATALOGUE, TODAY);
    expect(v.flags).toContain("multi-day");
  });
  it("proposes a new race of 10 km or longer, flagging what needs checking", () => {
    const v = classify(candidate({ name: "Carrera del Puerto", date: "2027-03-10" }), CATALOGUE, TODAY);
    expect(v).toMatchObject({ verdict: "newRace", distances: [21.1], minor: false });
    expect(v.flags).toEqual(expect.arrayContaining(["second-hand date", "weekday"]));
  });
  it("proposes a new 10K, from an aggregator too", () => {
    const v = classify(candidate({ name: "Carrera del Puerto", date: "2027-03-14", distances: [5, 10] }), CATALOGUE, TODAY);
    expect(v).toMatchObject({ verdict: "newRace", distances: [10], minor: false });
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
  it("drops a minor new race (under the second-hand bar) only an aggregator lists", () => {
    expect(worthProposing({ minor: true })).toBe(false);
  });
});

describe("apply: cleanName", () => {
  it.each([
    ["XXVI Media Maratón San Sebastián 2027", "Media Maratón San Sebastián"],
    ["42 Carrera Popular CaixaBank Villa de Aranjuez", "Carrera Popular CaixaBank Villa de Aranjuez"],
    ["MARATÓN DE ESTEPONA JARDIN DE LA COSTA DEL SOL", "Maratón de Estepona Jardin de la Costa del Sol"],
    ["CANFRANC-CANFRANC 2027", "Canfranc-Canfranc"],
    ["10K Valencia Ibercaja", "10K Valencia Ibercaja"],
    ["10 k y III Maraton-Trail Majadahonda", "10 k y III Maraton-Trail Majadahonda"],
    ["Trail Vielha Molieres 3010 -", "Trail Vielha Molieres 3010"],
    ["MITJA MARATÓ SAMARUC, 2026, Algemesí", "Mitja Marató Samaruc, Algemesí"],
    ["Trail Monte Ponoig, Polop de la Marina, 9e. Circuit Trail Marina 26/27", "Trail Monte Ponoig, Polop de la Marina"],
    ["CURSA TOMBATOSSALS TRAILS DE CASTELLÓ 26", "Cursa Tombatossals Trails de Castelló"],
    ["IV-Domusa Teknik 15 MLK (26km)", "Domusa Teknik 15 MLK (26km)"],
    ["X-Trail Valencia", "X-Trail Valencia"],
    ["10K Circuit de Jerez, Jerez", "10K Circuit de Jerez, Jerez"],
    ["Lliga de Muntanya València Sud. 26/27", ""],
    ["TRAIL DES FOULEES POUSSANAISES (7ème édition)", "Trail des Foulees Poussanaises"],
    ["Trail Nocturne de l'Ecoparc Catalan - 4ème édition", "Trail Nocturne de l'Ecoparc Catalan"],
    ["35° BOUCLES DE MAGUELONE", "Boucles de Maguelone"],
    ["Clermont l'Hérault Urban Trail CHUT 2026 By GROUPAMA", "Clermont l'Hérault Urban Trail CHUT"],
    ["Run by the Sea", "Run by the Sea"],
    ["Media Maratón Elche 7ª edición", "Media Maratón Elche"],
    ["Trail 4e Édition des Lacs", "Trail des Lacs"],
    ["Trail 1a Edición Sierra", "Trail Sierra"],
    ["Semi-Marathon de Paris - Édition 2027", "Semi-Marathon de Paris"],
  ])("%s", (raw, clean) => expect(cleanName(raw, "2026-12-13")).toBe(clean));
  it.each([
    ["17007 Girona", "Girona"],
    ["Pl. de Espańa, Fonelas", "Fonelas"],
    ["ALCOI", "Alcoi"],
    ["Spain", ""],
  ])("city %s", (raw, clean) => expect(cleanCity(raw, "ES")).toBe(clean));
});

describe("apply: webUrl", () => {
  it.each([
    ["www.benidormhalf.com", "https://www.benidormhalf.com/"],
    ["http://vinyolsmarato.cat/", "http://vinyolsmarato.cat/"],
    ["javascript:alert(1)", null],
    ["", null],
  ])("%s", (raw, url) => expect(webUrl(raw)).toBe(url));
});

describe("apply: plan", () => {
  const taken = () => new Set([...CATALOGUE.races.map((r) => r.slug), ...CATALOGUE.editions.map((e) => e.id)]);
  const proposal = (over: Record<string, unknown>, c: Record<string, unknown> = {}) => ({
    verdict: "newRace",
    distances: [21.1],
    flags: [],
    why: "",
    candidate: candidate({ source: "rockthesport", firstHand: true, name: "XII Mitja Marató Ripoll 2027", city: "Ripoll", ...c }),
    ...over,
  });

  it("adds a clean first-hand new race with one edition at its headline distance", () => {
    const w = plan(proposal({ distances: [10, 21.1] }), CATALOGUE, taken());
    expect(w.ledger).toMatchObject({ status: "inserted", race_slug: "mitja-marato-ripoll", edition_id: "mitja-marato-ripoll-2027-03-07" });
    expect(w.race).toMatchObject({ name: "Mitja Marató Ripoll", country: "ES", distances: [21.1], terrain: "road" });
    expect(w.edition).toMatchObject({ race_slug: "mitja-marato-ripoll", distance_km: 21.1 });
  });
  it("marks a race trail by its source's sport or its name", () => {
    expect(plan(proposal({}, { name: "Trail Serra de Ripoll 2027" }), CATALOGUE, taken()).race.terrain).toBe("trail");
    expect(plan(proposal({}, { sport: "trail" }), CATALOGUE, taken()).race.terrain).toBe("trail");
  });
  it("never takes a slug already in use", () => {
    const used = taken();
    used.add("mitja-marato-ripoll");
    expect(plan(proposal({}), CATALOGUE, used).race.slug).toBe("mitja-marato-ripoll-2");
  });
  it("leaves an aggregator-only new edition of a known race for review", () => {
    const w = plan(
      proposal({ verdict: "newEdition", slug: "dublin-marathon", distances: [42.2] }, { source: "runninglife", firstHand: false }),
      CATALOGUE,
      taken(),
    );
    expect(w.ledger).toMatchObject({ status: "review", note: "one aggregator only" });
    expect(w.edition).toBeUndefined();
  });
  it("adds a new edition at the catalogue race's own distance", () => {
    const w = plan(
      proposal({ verdict: "newEdition", slug: "dublin-marathon", distances: [10, 42.2] }, { name: "Dublin Marathon", country: "IE" }),
      CATALOGUE,
      taken(),
    );
    expect(w.race).toBeUndefined();
    expect(w.edition).toEqual({ id: "dublin-marathon-2027-03-07", race_slug: "dublin-marathon", date: "2027-03-07", distance_km: 42.2 });
  });
  it.each([
    [{ verdict: "dateChange", previousDate: "2027-04-11" }, {}, "catalogue has 2027-04-11"],
    [{ verdict: "review", why: "weak name 0.40" }, {}, "weak name 0.40"],
    [{ flags: ["weekday"] }, {}, "weekday"],
    [{ flags: ["multi-day"] }, {}, "multi-day"],
    [{ flags: ["tbc", "no coordinates"] }, {}, "tbc, no coordinates"],
    [{ verdict: "newEdition", slug: "dublin-marathon", distances: [21.1] }, {}, "no distance in common with the catalogue race"],
  ])("leaves %o for review", (over, c, note) => {
    const w = plan(proposal(over, c), CATALOGUE, taken());
    expect(w.ledger).toMatchObject({ status: "review", note });
    expect(w.race ?? w.edition).toBeUndefined();
  });
  it("leaves a doubtful date for review", () => {
    const w = plan(proposal({ flags: ["date not confirmed by the page"] }), CATALOGUE, taken());
    expect(w.ledger).toMatchObject({ status: "review", note: "date not confirmed by the page" });
  });
  it("parks an aggregator-only race outside the review queue", () => {
    const w = plan(proposal({}, { source: "runninglife", firstHand: false }), CATALOGUE, taken());
    expect(w.ledger).toMatchObject({ status: "waiting", note: "one aggregator only" });
    expect(w.race ?? w.edition).toBeUndefined();
  });
  it("parks a flagged aggregator-only race too: its flags are checked once a second source lists it", () => {
    const w = plan(proposal({ flags: ["weekday", "multi-day"] }, { source: "findarace", firstHand: false }), CATALOGUE, taken());
    expect(w.ledger).toMatchObject({ status: "waiting", note: "one aggregator only" });
    const second = plan(
      proposal({ flags: ["weekday"], alsoIn: [{ source: "x", url: "u" }] }, { source: "findarace", firstHand: false }),
      CATALOGUE,
      taken(),
    );
    expect(second.ledger).toMatchObject({ status: "review", note: "weekday" });
  });
  it("never adds a second race under a name the catalogue already has", () => {
    const withRipoll = { ...CATALOGUE, races: [...CATALOGUE.races, race({ slug: "mitja-marato-ripoll", name: "Mitja Marató Ripoll" })] };
    const w = plan(proposal({}), withRipoll, taken());
    expect(w.ledger).toMatchObject({ status: "review", note: "a race with this name exists" });
    expect(w.race).toBeUndefined();
  });
  it("adds an aggregator race once a second source lists it", () => {
    const w = plan(proposal({ alsoIn: [{ source: "x", url: "u" }] }, { source: "runninglife", firstHand: false }), CATALOGUE, taken());
    expect(w.ledger.status).toBe("inserted");
  });
});

describe("apply: buildSql", () => {
  it("carries the rows as one dollar-quoted literal whose tag the data cannot close", () => {
    const sql = buildSql({ races: [{ name: "O'Brien $$ Run" }], editions: [], ledger: [] });
    const tag = sql.match(/\$(crawl_[0-9a-f]+)\$/)![1];
    expect(sql.split(`$${tag}$`)).toHaveLength(3);
    expect(sql).toContain("O'Brien $$ Run");
  });
  it("never records a row as inserted that the statement did not write", () => {
    const sql = buildSql({ races: [], editions: [], ledger: [] });
    expect(sql).toMatch(/case when l\.status = 'inserted' and not exists \(select 1 from new_editions n where n\.id = l\.edition_id\)/);
  });
  it("strips what Postgres's jsonb refuses, so one scraped string can't abort the write", () => {
    const sql = buildSql({ races: [{ name: "Bad\u0000name \ud800" }], editions: [], ledger: [] });
    expect(sql).not.toContain("\\u0000");
    expect(sql).not.toMatch(/\\ud800/i);
    expect(sql).toContain("Badname");
  });
});

describe("classify: tbc", () => {
  it("flags a date the source itself calls provisional", () => {
    const v = classify(candidate({ name: "Carrera del Puerto", text: "21 km, scheduled for 7 March 2027 (TBC)." }), CATALOGUE, TODAY);
    expect(v.flags).toContain("tbc");
  });
});

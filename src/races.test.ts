import { describe, it, expect, vi } from "vitest";

const rpc = vi.fn();
const tables: Record<string, (col: string, v: unknown) => unknown[]> = {};
// A tiny PostgREST stand-in: select(...).in/eq(col, v) answers from `tables[name]`.
const insert = vi.fn();
const from = (name: string) => ({ select: () => {
  const answer = (col: string, v: unknown) => Promise.resolve({ data: tables[name]?.(col, v) ?? [], error: null });
  return { in: answer, eq: answer };
}, insert: (row: unknown) => ({ select: () => ({ single: () => insert(name, row) }) }) });
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (n: string) => from(n) } }));
vi.mock("./db", () => ({ currentUserId: () => "u1" }));
vi.mock("./notify", () => ({ notifyContribution: vi.fn() }));

const { raceUrl, addRace, findRaceDuplicates, duplicateRefusal, listKnownRaces, searchRaces, peekRaceSearch, clearRaceSearchCache, SEARCH_CACHE_MS } = await import("./races");

describe("raceUrl", () => {
  it("keeps web links", () => {
    expect(raceUrl("https://example.org/race")).toBe("https://example.org/race");
    expect(raceUrl("http://example.org/")).toBe("http://example.org/");
  });

  it("completes a bare host, which otherwise renders as a broken relative link", () => {
    expect(raceUrl(" www.example.org/race ")).toBe("https://www.example.org/race");
  });

  it("refuses any other scheme, including the app's own deep link", () => {
    expect(raceUrl("javascript:alert(1)")).toBeNull();
    expect(raceUrl("solutions.camboulive.run://callback?code=x")).toBeNull();
    expect(raceUrl("data:text/html,<b>x</b>")).toBeNull();
  });

  it("treats empty as no link", () => {
    expect(raceUrl("")).toBeNull();
    expect(raceUrl(null)).toBeNull();
  });
});

describe("addRace distinct_from", () => {
  const ok = (row: Record<string, unknown>) => ({ data: { slug: row.slug, name: row.name }, error: null });

  it("leaves the column out of an ordinary save, so it works before the migration lands", async () => {
    insert.mockReset().mockImplementation(async (_t: string, row: Record<string, unknown>) => ok(row));
    await addRace({ name: "Hackney Half", country: "GB" });
    expect(insert.mock.calls[0][1]).not.toHaveProperty("distinct_from");
  });

  it("sends the race the runner said this isn't, and retries without it if the column is missing", async () => {
    insert.mockReset()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST204", message: "column not found" } })
      .mockImplementation(async (_t: string, row: Record<string, unknown>) => ok(row));
    await addRace({ name: "Riverside Charity Run", country: "GB", distinctFrom: "riverside-run" });
    expect(insert.mock.calls[0][1]).toMatchObject({ slug: "riverside-charity-run", distinct_from: "riverside-run" });
    expect(insert.mock.calls[1][1]).toMatchObject({ slug: "riverside-charity-run" });
    expect(insert.mock.calls[1][1]).not.toHaveProperty("distinct_from");
  });
});

describe("findRaceDuplicates", () => {
  it("sends what the form knows and maps each match", async () => {
    rpc.mockReset().mockResolvedValue({ data: [{ slug: "kili", name: "Kilimanjaro Marathon", country: "TZ", strong: true, edition_id: "kili-2027-02-07",
      dist_km: 0.1, editions: [{ id: "kili-2027-02-07", race_slug: "kili", date: "2027-02-07", distance_km: 42.2, elevation: 500 }] }], error: null });
    const [d] = await findRaceDuplicates({ name: " Kili ", country: "TZ", lat: -3.47, lng: 37.38, date: "2027-02-07", distanceKm: 42.2 });
    expect(rpc).toHaveBeenCalledWith("race_duplicates", expect.objectContaining({ p_name: "Kili", p_country: "TZ", p_lat: -3.47, p_date: "2027-02-07", p_distance_km: 42.2 }));
    expect(d).toMatchObject({ strong: true, editionId: "kili-2027-02-07", race: { slug: "kili", distKm: 0.1, editions: [{ distanceKm: 42.2 }] } });
  });

  it("throws on a failed call, so the caller decides", async () => {
    rpc.mockReset().mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(findRaceDuplicates({ name: "x" })).rejects.toBeTruthy();
  });

  it("reads the database's duplicate refusal and nothing else", () => {
    expect(duplicateRefusal({ code: "RC409", details: "kili", hint: "kili-2027-02-07" })).toEqual({ raceSlug: "kili", editionId: "kili-2027-02-07" });
    expect(duplicateRefusal({ code: "23505", details: "x" })).toBeNull();
    expect(duplicateRefusal(new Error("x"))).toBeNull();
  });
});

describe("searchRaces session cache", () => {
  const page = { races: [{ slug: "a", name: "A", editions: [{ id: "a-1", race_slug: "a", date: "2027-01-01", distance_km: 10 }] }], next: null, total: 1 };

  it("answers a repeated page from memory, sends several countries as one array", async () => {
    clearRaceSearchCache();
    rpc.mockReset().mockResolvedValue({ data: page, error: null });
    const params = { query: "a", countries: ["ES", "FR"] };
    const first = await searchRaces(params);
    const again = await searchRaces(params);
    expect(again).toBe(first);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_query: "a", p_countries: ["ES", "FR"] });
    expect(peekRaceSearch(params, null, Date.now() + SEARCH_CACHE_MS + 1)).toBeNull();
  });

  it("never caches a failure, and sends no country filter for an empty list", async () => {
    clearRaceSearchCache();
    rpc.mockReset().mockResolvedValueOnce({ data: null, error: { message: "down" } }).mockResolvedValueOnce({ data: page, error: null });
    await expect(searchRaces({ countries: [] })).rejects.toBeTruthy();
    await expect(searchRaces({ countries: [] })).resolves.toMatchObject({ total: 1 });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_countries: null });
  });
});

describe("listKnownRaces", () => {
  it("includes a race someone else created when this account added one of its dates", async () => {
    tables.race_editions = (col, v) => col === "created_by" && v === "me"
      ? [{ race_slug: "their-race" }]
      : col === "race_slug" ? [{ id: "their-race-2027-05-02", race_slug: "their-race", date: "2027-05-02", distance_km: 10, created_by: "me", verified: true }] : [];
    tables.races = (col) => col === "slug" ? [{ slug: "their-race", name: "Their Race", created_by: "someone" }] : [];
    const races = await listKnownRaces({ editionIds: [], userId: "me" });
    expect(races.map(r => r.id)).toEqual(["their-race"]);
    expect(races[0].editions[0]).toMatchObject({ id: "their-race-2027-05-02", createdBy: "me", verified: true });
  });
});

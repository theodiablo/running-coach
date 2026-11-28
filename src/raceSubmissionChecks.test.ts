import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countryOptions } from "./utils/country";
import { raceUrl } from "./utils/raceForm";

// The database half of the add-race checks must accept exactly what the form sends.
const DIR = join(process.cwd(), "supabase", "migrations");
const latest = (pattern: RegExp) => {
  const hits = readdirSync(DIR).filter(n => n.endsWith(".sql")).sort()
    .map(n => readFileSync(join(DIR, n), "utf8").replace(/--.*$/gm, ""))
    .flatMap(sql => [...sql.matchAll(pattern)].map(m => m[1]));
  return hits.at(-1) ?? "";
};

describe("races constraints match the form", () => {
  it("races_country_code lists the same countries as the picker", () => {
    const sql = latest(/add constraint races_country_code\s+check \(country in \(([\s\S]*?)\)\)/gi);
    const db = [...sql.matchAll(/'([A-Z]{2})'/g)].map(m => m[1]).sort();
    expect(db).toEqual(countryOptions("en").map(o => o.code).sort());
  });

  it("races_url_host accepts every link raceUrl produces, and nothing raceUrl refuses gets stored", () => {
    const sql = latest(/add constraint races_url_host\s+check \(url is null or url ~\* '([^']+)'\)/gi);
    expect(sql).not.toBe("");
    const db = new RegExp(sql.replace("xn-{2}", "xn--"), "i");
    for (const input of ["https://https//:Kilimanjarointernationalmarathon.com", "www.example.org/race", "example.org:8080/x?a=1",
      "https://münchen-marathon.de", "http://example.co.uk", "https://fr.spartan.com/fr/race/detail/11053/overview"]) {
      expect(db.test(raceUrl(input) ?? "")).toBe(true);
    }
    for (const stored of ["https://https//:Kilimanjarointernationalmarathon.com", "https://localhost/", "https://192.168.0.1/"]) {
      expect(db.test(stored)).toBe(false);
    }
  });
});

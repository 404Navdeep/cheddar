import { expect, test } from "bun:test";
import {
  dateLadder,
  dateProblems,
  datesForSubmit,
  draftFromStored,
  easternTime,
  matchDate,
  outcomeMatchesEvent,
  phraseFor,
} from "../src/lib/market-dates.ts";
import { fillRuleTemplate } from "../src/lib/rule-templates.ts";

/** Wednesday, Nov 25, 2026, 15:00 ET (EST, UTC-5). */
const NOW = easternTime(2026, 11, 25, 15, 0);

function at(input: string, now = NOW) {
  const m = matchDate(input, now);
  expect(m, input).not.toBeNull();
  return m!;
}

test("matches a named day at 11:59 PM ET, rolling the year forward", () => {
  const m = at("March 31");
  expect(m.date.toISOString()).toBe(easternTime(2027, 3, 31, 23, 59).toISOString());
  expect(m.label).toBe("By Mar 31, 2027");
  expect(m.when).toBe("Mar 31, 2027 · 11:59 PM ET");
  expect(at("Mar 31, 2027").date.toISOString()).toBe(m.date.toISOString());
  expect(at("31 March 2027").date.toISOString()).toBe(m.date.toISOString());
  expect(at("3/31/2027").date.toISOString()).toBe(m.date.toISOString());
  expect(at("2027-03-31").date.toISOString()).toBe(m.date.toISOString());
  expect(at("by March 31st").date.toISOString()).toBe(m.date.toISOString());
});

test("end of a month and a quarter land on the last day", () => {
  expect(at("end of June").date.toISOString()).toBe(easternTime(2027, 6, 30, 23, 59).toISOString());
  expect(at("June 2027").date.toISOString()).toBe(easternTime(2027, 6, 30, 23, 59).toISOString());
  expect(at("Q2 2027").date.toISOString()).toBe(easternTime(2027, 6, 30, 23, 59).toISOString());
  expect(at("Q4").date.toISOString()).toBe(easternTime(2026, 12, 31, 23, 59).toISOString());
  expect(at("end of this month").date.toISOString()).toBe(easternTime(2026, 11, 30, 23, 59).toISOString());
});

test("keeps a clock the maker typed, in Eastern Time", () => {
  const m = at("June 30, 2027 3:00 PM");
  expect(m.date.toISOString()).toBe(easternTime(2027, 6, 30, 15, 0).toISOString());
  expect(m.when).toBe("Jun 30, 2027 · 3:00 PM ET");
  expect(phraseFor(m.date)).toBe("Jun 30, 2027 3:00 PM");
  expect(matchDate(phraseFor(m.date), NOW)?.date.toISOString()).toBe(m.date.toISOString());
});

test("relative dates count from today in Eastern Time", () => {
  expect(at("tomorrow").date.toISOString()).toBe(easternTime(2026, 11, 26, 23, 59).toISOString());
  expect(at("in 2 weeks").date.toISOString()).toBe(easternTime(2026, 12, 9, 23, 59).toISOString());
  expect(at("next Friday").date.toISOString()).toBe(easternTime(2026, 11, 27, 23, 59).toISOString());
  expect(at("Friday").date.toISOString()).toBe(easternTime(2026, 11, 27, 23, 59).toISOString());
});

test("11:59 PM respects daylight saving", () => {
  expect(easternTime(2027, 3, 31, 23, 59).toISOString()).toBe("2027-04-01T03:59:00.000Z");
  expect(easternTime(2027, 1, 31, 23, 59).toISOString()).toBe("2027-02-01T04:59:00.000Z");
});

test("rejects text that is not a date", () => {
  expect(matchDate("")).toBeNull();
  expect(matchDate("Orpheus")).toBeNull();
  expect(matchDate("February 31, 2027")).toBeNull();
});

test("ladders skip dates that have already passed", () => {
  expect(dateLadder("months", NOW).map((d) => d.label)).toEqual([
    "By Nov 30, 2026",
    "By Dec 31, 2026",
    "By Jan 31, 2027",
    "By Feb 28, 2027",
  ]);
  expect(dateLadder("quarters", NOW).map((d) => d.label)).toEqual([
    "By Dec 31, 2026",
    "By Mar 31, 2027",
    "By Jun 30, 2027",
    "By Sep 30, 2027",
  ]);
  expect(dateLadder("year", NOW)[0]?.label).toBe("By Dec 31, 2026");
});

test("a stored date round-trips until the maker retypes it", () => {
  const iso = easternTime(2027, 3, 31, 23, 59).toISOString();
  const row = draftFromStored("a", "By Mar 31, 2027", iso);
  const [saved] = datesForSubmit([row], NOW);
  expect(saved?.iso).toBe(iso);
  expect(saved?.label).toBe("By Mar 31, 2027");
});

test("two dates are required, and the same day cannot be listed twice", () => {
  const one = [{ id: "a", text: "March 31", label: "", pinned: false, lockedIso: null }];
  expect(dateProblems(one, NOW) ?? "").toMatch(/at least two/);
  const same = [
    { id: "a", text: "March 31, 2027", label: "", pinned: false, lockedIso: null },
    { id: "b", text: "2027-03-31", label: "", pinned: false, lockedIso: null },
  ];
  expect(dateProblems(same, NOW) ?? "").toMatch(/same date/);
  const ok = [
    ...same.slice(0, 1),
    { id: "b", text: "end of June 2027", label: "", pinned: false, lockedIso: null },
  ];
  expect(dateProblems(ok, NOW)).toBeNull();
  expect(datesForSubmit(ok, NOW).map((d) => d.label)).toEqual(["By Mar 31, 2027", "By Jun 30, 2027"]);
});

test("an event date matches every outcome on or after it", () => {
  const march = easternTime(2027, 3, 31, 23, 59);
  const june = easternTime(2027, 6, 30, 23, 59);
  const event = easternTime(2027, 4, 2, 23, 59);
  expect(outcomeMatchesEvent(march.toISOString(), event)).toBe(false);
  expect(outcomeMatchesEvent(june.toISOString(), event)).toBe(true);
  expect(outcomeMatchesEvent(null, event)).toBeNull();
});

test("the date-ladder rules list the matched dates", () => {
  const text = fillRuleTemplate("date-ladder", {
    title: "Will a new YSWS ship?",
    dates: [
      { label: "By Mar 31, 2027", when: "Mar 31, 2027 · 11:59 PM ET" },
      { label: "By Jun 30, 2027", when: "Jun 30, 2027 · 11:59 PM ET" },
    ],
    closes: null,
  });
  expect(text).toMatch(/Resolution/);
  expect(text).toMatch(/Source/);
  expect(text).toMatch(/Edge cases/);
  expect(text).toMatch(/11:59 PM ET/);
  expect(text).toMatch(/By Mar 31, 2027 \(Mar 31, 2027 · 11:59 PM ET\)/);
  expect(text).toMatch(/later date can resolve to "Yes"/);
  expect(text).toMatch(/“Will a new YSWS ship”/);
});

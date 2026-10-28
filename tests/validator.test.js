const { parseStartsAt } = require("../utils/validator");

// The point of parseStartsAt is to be stricter than `new Date(string)`. Every
// "rejects" case below is one that `new Date` would have accepted.

describe("parseStartsAt", () => {
  it("returns the same instant for a UTC and an offset spelling", () => {
    const utc = parseStartsAt("2099-12-01T10:00:00Z");
    const offset = parseStartsAt("2099-12-01T15:30:00+05:30");

    expect(utc).toBeInstanceOf(Date);
    expect(utc.toISOString()).toBe("2099-12-01T10:00:00.000Z");
    expect(offset.getTime()).toBe(utc.getTime());
  });

  it("accepts optional seconds and fractional seconds", () => {
    expect(parseStartsAt("2099-12-01T10:00Z")).toBeInstanceOf(Date);
    expect(parseStartsAt("2099-12-01T10:00:00.123Z").getUTCMilliseconds()).toBe(
      123,
    );
  });

  it.each([
    ["no offset (would be read as server-local time)", "2099-12-01T10:00:00"],
    ["a date with no time", "2099-12-01"],
    ["the old 12-hour time format", "10:00 AM"],
    ["a space instead of T", "2099-12-01 10:00:00Z"],
    ["a day that does not exist", "2099-02-30T10:00:00Z"],
    ["a month that does not exist", "2099-13-01T10:00:00Z"],
    ["hour 24", "2099-12-01T24:00:00Z"],
    ["minute 60", "2099-12-01T10:60:00Z"],
    ["an offset hour out of range", "2099-12-01T10:00:00+24:00"],
    ["trailing text", "2099-12-01T10:00:00Z; drop"],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseStartsAt(value)).toBeNull();
  });

  it("accepts 29 February only in a leap year", () => {
    expect(parseStartsAt("2096-02-29T10:00:00Z")).toBeInstanceOf(Date);
    expect(parseStartsAt("2099-02-29T10:00:00Z")).toBeNull();
  });

  it.each([[undefined], [null], [20991201], [{}], [["2099-12-01T10:00:00Z"]]])(
    "rejects a non-string (%p)",
    (value) => {
      expect(parseStartsAt(value)).toBeNull();
    },
  );
});

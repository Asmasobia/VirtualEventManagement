function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPassword(password) {
  if (!password || password.length < 6) {
    return {
      valid: false,
      message: "Password must be at least 6 characters long.",
    };
  }
  return { valid: true, message: "" };
}

// An event's start is ONE instant, so the client must name the instant: an
// ISO-8601 date-time that carries its own UTC offset ("2026-12-01T10:00:00Z" or
// "2026-12-01T15:30:00+05:30"). The old `date: "2026-12-01"` + `time: "10:00 AM"`
// pair named no timezone at all, so nobody could say when the event started.
//
// This is stricter than `new Date(string)` on purpose, because Date is lenient
// in exactly the ways that hurt here:
//   - "2026-12-01T10:00:00" (no offset) is read as the SERVER's local time, so
//     the same request means a different instant on a laptop and in a container.
//   - "2026-02-30T10:00:00Z" is silently rolled over to 2 March.
//   - "2026-12-01T24:00:00Z" is accepted as midnight the next day.
// The regex rejects the shape, the range checks reject impossible clock values,
// and the round-trip check rejects impossible calendar dates.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** The instant `value` names as a Date, or null if it is not a valid one. */
function parseStartsAt(value) {
  if (typeof value !== "string") return null;
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return null;

  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offsetHour = m[8] === undefined ? 0 : Number(m[8]);
  const offsetMinute = m[9] === undefined ? 0 : Number(m[9]);

  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offsetHour > 23 || offsetMinute > 59) return null;

  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(value);
}

function hasRequiredFields(body, fields) {
  const missingFields = fields.filter(
    (field) => !body[field] || body[field].toString().trim() === "",
  );
  if (missingFields.length > 0) {
    return {
      valid: false,
      message: `Missing required fields: ${missingFields.join(", ")}`,
    };
  }
  return { valid: true, message: "" };
}

module.exports = {
  isValidEmail,
  isValidPassword,
  parseStartsAt,
  hasRequiredFields,
};

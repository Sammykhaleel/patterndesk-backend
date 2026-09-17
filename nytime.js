'use strict';

/**
 * New York clock times, in UTC, with daylight saving handled.
 *
 * The US cash session is 09:30-16:00 New York time. In UTC that is 13:30-20:00
 * from mid-March to early November and 14:30-21:00 the rest of the year.
 * Hard-coding either pair is right for about eight months and wrong for four,
 * and it fails silently: a stock perp is called "open" for an hour of flat
 * overnight bars and "closed" for the first hour of real trading.
 *
 * The offset is read from the platform's time-zone database rather than from
 * a rule written here, so a change to US daylight-saving law does not need a
 * change to this file.
 */

const NY = 'America/New_York';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
});

/** New York weekday (0 Sunday … 6 Saturday), hour and minute at an instant. */
function nyParts(ms) {
  const parts = {};
  for (const p of partsFormatter.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/**
 * Hours New York is behind UTC on a given UTC date: 4 in summer, 5 in winter.
 *
 * Read at 16:00 UTC — mid-session in both seasons, and hours away from the
 * 02:00 local changeover, which happens on a Sunday when nothing trades.
 */
function nyOffsetHours(dayUtcMidnight) {
  const probe = dayUtcMidnight + 16 * 3600000;
  return 16 - nyParts(probe).hour;
}

/** 09:30 New York on the given UTC date, as a UTC timestamp. */
function nyOpenUtc(dayUtcMidnight) {
  return dayUtcMidnight + (9.5 + nyOffsetHours(dayUtcMidnight)) * 3600000;
}

/** 16:00 New York on the given UTC date, as a UTC timestamp. */
function nyCloseUtc(dayUtcMidnight) {
  return dayUtcMidnight + (16 + nyOffsetHours(dayUtcMidnight)) * 3600000;
}

/** Whether the given UTC date is a weekday in New York. */
function isNyWeekday(dayUtcMidnight) {
  const d = nyParts(dayUtcMidnight + 16 * 3600000).day;
  return d >= 1 && d <= 5;
}

/**
 * Whether the US cash session is open at this instant.
 *
 * Holidays are not modelled: a stock perp on a holiday prints flat bars, which
 * score as "does not cover its costs" — the right answer by another route.
 */
function usSessionOpen(ms) {
  const { day, hour, minute } = nyParts(ms);
  if (day === 0 || day === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

module.exports = { nyOpenUtc, nyCloseUtc, nyOffsetHours, isNyWeekday, usSessionOpen, nyParts };

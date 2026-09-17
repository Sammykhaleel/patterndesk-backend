'use strict';

/**
 * New York clock times in UTC.
 *
 * The bug this exists for: the US session was written as 13:30-20:00 UTC,
 * which is correct from March to November and wrong by an hour in both
 * directions for the rest of the year. Every assertion below is therefore
 * made in BOTH seasons — a summer-only test passes against the bug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { nyOpenUtc, nyCloseUtc, nyOffsetHours, isNyWeekday } = require('../nytime');

const day = (y, m, d) => Date.UTC(y, m - 1, d);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

test('the open and close move with daylight saving', () => {
  assert.equal(hhmm(nyOpenUtc(day(2026, 9, 16))), '13:30', 'summer open');
  assert.equal(hhmm(nyCloseUtc(day(2026, 9, 16))), '20:00', 'summer close');
  assert.equal(hhmm(nyOpenUtc(day(2026, 1, 14))), '14:30', 'winter open');
  assert.equal(hhmm(nyCloseUtc(day(2026, 1, 14))), '21:00', 'winter close');
});

test('the changeover weeks land on the right side', () => {
  // US clocks go forward on the second Sunday of March and back on the first
  // Sunday of November. The weekdays either side must disagree.
  assert.equal(nyOffsetHours(day(2026, 3, 6)), 5, 'Friday before the spring change');
  assert.equal(nyOffsetHours(day(2026, 3, 9)), 4, 'Monday after it');
  assert.equal(nyOffsetHours(day(2026, 10, 30)), 4, 'Friday before the autumn change');
  assert.equal(nyOffsetHours(day(2026, 11, 2)), 5, 'Monday after it');
});

test('weekdays are New York weekdays', () => {
  assert.equal(isNyWeekday(day(2026, 9, 18)), true, 'Friday');
  assert.equal(isNyWeekday(day(2026, 9, 19)), false, 'Saturday');
  assert.equal(isNyWeekday(day(2026, 9, 20)), false, 'Sunday');
  assert.equal(isNyWeekday(day(2026, 9, 21)), true, 'Monday');
});

test('NYSE holidays are not sessions, and weekends never are', () => {
  const { isNyseSession, isNyseHoliday } = require('../nytime');
  assert.equal(isNyseHoliday(day(2026, 11, 26)), true, 'Thanksgiving 2026');
  assert.equal(isNyseSession(day(2026, 11, 26)), false);
  assert.equal(isNyseSession(day(2026, 11, 25)), true, 'the Wednesday before trades');
  assert.equal(isNyseSession(day(2027, 7, 5)), false, 'Independence Day observed on Monday');
  assert.equal(isNyseSession(day(2026, 9, 19)), false, 'a Saturday that is on no list');
  assert.equal(isNyseSession(day(2026, 9, 17)), true, 'an ordinary Thursday');
});

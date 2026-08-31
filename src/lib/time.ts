import { DateTime, Effect, Option } from "effect";

import { ValidationError } from "./model";

const LOCAL_DATE_TIME = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const LEGACY_LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

const takeDigits = (value: string) => value.replace(/\D/g, "").slice(0, 14);

export const formatLocalDateTimeInput = (value: string, previousValue = "") => {
  const deletedAutomaticDateSeparator =
    value.length === previousValue.length - 1 &&
    previousValue.endsWith("/") &&
    value === previousValue.slice(0, -1);
  const digits = takeDigits(deletedAutomaticDateSeparator ? value.slice(0, -1) : value);
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);
  const hour = digits.slice(8, 10);
  const minute = digits.slice(10, 12);
  const second = digits.slice(12, 14);

  let formatted = day;
  if (day.length === 2) formatted += "/";
  formatted += month;
  if (month.length === 2) formatted += "/";
  formatted += year;
  if (hour.length > 0) formatted += ` ${hour}`;
  if (minute.length > 0) formatted += `:${minute}`;
  if (second.length > 0) formatted += `:${second}`;
  return formatted;
};

export const localToEpochSeconds = (input: string, timezone: string) =>
  Effect.gen(function* () {
    const value = input.trim();
    const match = LOCAL_DATE_TIME.exec(value);
    const legacyMatch = LEGACY_LOCAL_DATE_TIME.exec(value);
    if (match === null) {
      if (legacyMatch === null)
        return yield* new ValidationError({
          message: `Invalid date/time “${input}”; use DD/MM/YYYY HH:mm:ss`,
        });
    }
    const [, day, month, y, hour, minute, second] = match ?? [
      legacyMatch?.[0],
      legacyMatch?.[3],
      legacyMatch?.[2],
      legacyMatch?.[1],
      legacyMatch?.[4],
      legacyMatch?.[5],
      legacyMatch?.[6] ?? "0",
    ];
    if (
      y === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined
    ) {
      return yield* new ValidationError({ message: `Invalid date/time “${input}”` });
    }
    const yearValue = Number(y);
    const monthValue = Number(month);
    const dayValue = Number(day);
    const hourValue = Number(hour);
    const minuteValue = Number(minute);
    const secondValue = Number(second);
    const daysInMonth = new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate();
    if (
      yearValue < 1 ||
      monthValue < 1 ||
      monthValue > 12 ||
      dayValue < 1 ||
      dayValue > daysInMonth ||
      hourValue < 0 ||
      hourValue > 23 ||
      minuteValue < 0 ||
      minuteValue > 59 ||
      secondValue < 0 ||
      secondValue > 59
    ) {
      return yield* new ValidationError({ message: `Invalid local date/time: ${input}` });
    }
    const zoned = DateTime.makeZoned(
      {
        year: yearValue,
        month: monthValue,
        day: dayValue,
        hours: hourValue,
        minutes: minuteValue,
        seconds: secondValue,
      },
      { timeZone: timezone, adjustForTimeZone: true, disambiguation: "reject" },
    );
    return yield* Option.match(zoned, {
      onNone: () =>
        new ValidationError({ message: `Invalid local time or timezone: ${input} [${timezone}]` }),
      onSome: (value) => Effect.succeed(DateTime.toEpochMillis(value) / 1000),
    });
  });

export const defaultRange = (
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
) => {
  const until = new Date();
  const from = new Date(until.getTime() - 60 * 60 * 1000);
  const format = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}:${part("second")}`;
  };
  return { from: format(from), until: format(until), timezone };
};

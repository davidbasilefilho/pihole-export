import { DateTime, Effect, Option } from "effect";

import { ValidationError } from "./model";

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

export const localToEpochSeconds = (input: string, timezone: string) =>
  Effect.gen(function* () {
    const match = LOCAL_DATE_TIME.exec(input.trim());
    if (match === null) {
      return yield* new ValidationError({
        message: `Invalid date/time “${input}”; use YYYY-MM-DD HH:mm[:ss]`,
      });
    }
    const [, y, month, day, hour, minute, second = "0"] = match;
    if (
      y === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined
    ) {
      return yield* new ValidationError({ message: `Invalid date/time “${input}”` });
    }
    const zoned = DateTime.makeZoned(
      {
        year: Number(y),
        month: Number(month),
        day: Number(day),
        hours: Number(hour),
        minutes: Number(minute),
        seconds: Number(second),
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
  const format = (date: Date) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  return { from: format(from), until: format(until), timezone };
};

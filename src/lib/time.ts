import { backend } from "./backend";

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
  backend<number>({ op: "time", input, timezone });

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

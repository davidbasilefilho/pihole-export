import { Effect } from "effect";

import { backend } from "./backend";

/** Deliberately independent of online authentication and environment credentials. */
export const runOffline = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flags = new Map<string, string>();
    const accepted = new Set([
      "offline",
      "coverage",
      "from",
      "until",
      "timezone",
      "output",
      "format",
      "domain",
      "client-ip",
      "client-name",
      "upstream",
      "type",
      "status",
      "reply",
      "dnssec",
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--headless") continue;
      if (token === "--isolated-backup") {
        flags.set("isolated-backup", "true");
        continue;
      }
      const name = token?.slice(2) ?? "";
      const value = args[index + 1];
      if (
        !token?.startsWith("--") ||
        !accepted.has(name) ||
        value === undefined ||
        value.startsWith("--")
      ) {
        return yield* Effect.fail(
          new Error("Invalid offline argument; online/credential flags are not accepted"),
        );
      }
      if (flags.has(name)) return yield* Effect.fail(new Error("Duplicate offline argument"));
      flags.set(name, value);
      index += 1;
    }
    for (const name of [
      "offline",
      "coverage",
      "from",
      "until",
      "timezone",
      "output",
      "isolated-backup",
    ]) {
      if (!flags.get(name)) return yield* Effect.fail(new Error(`Offline mode requires --${name}`));
    }
    const filters = Object.fromEntries(
      ["from", "until", "timezone", "domain", "upstream", "type", "status", "reply", "dnssec"].map(
        (name) => [name, flags.get(name) ?? ""],
      ),
    );
    filters.clientIp = flags.get("client-ip") ?? "";
    filters.clientName = flags.get("client-name") ?? "";
    return yield* backend<unknown>({
      op: "offline",
      input: {
        snapshot: flags.get("offline"),
        coverage: flags.get("coverage"),
        isolatedBackup: true,
        filters,
        path: flags.get("output"),
        format: flags.get("format") ?? "csv",
      },
    });
  });

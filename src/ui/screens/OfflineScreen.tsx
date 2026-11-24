/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { Effect } from "effect";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { backend, type ExportProgress } from "../../lib/backend";
import { logsDirectory } from "../../lib/diagnostics";
import { ActionButton, Field, Section } from "../primitives";
import { theme } from "../theme";

const fields = [
  ["snapshot", "Existing local snapshot *"],
  ["coverage", "Coverage / policy JSON *"],
  ["from", "Timestamp from *"],
  ["until", "Timestamp until *"],
  ["timezone", "Timezone *"],
  ["domain", "Domain"],
  ["clientIp", "Client IP"],
  ["clientName", "Client name"],
  ["upstream", "Upstream"],
  ["type", "Type"],
  ["status", "Status"],
  ["reply", "Reply"],
  ["dnssec", "DNSSEC"],
  ["path", "Destination (local file) *"],
] as const;
const formats = ["csv", "jsonl", "sqlite", "parquet"] as const;
export function OfflineScreen(props: { onBack: () => void }) {
  const [values, setValues] = createSignal<Record<string, string>>({ timezone: "UTC" });
  const [focus, setFocus] = createSignal(0);
  const [isolated, setIsolated] = createSignal(false);
  const [format, setFormat] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [progress, setProgress] = createSignal<ExportProgress>();
  const [elapsed, setElapsed] = createSignal(0);
  let scroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    scroll?.scrollTo(focus() < 14 ? Math.max(0, focus() * 3) : 65);
  });
  let started = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    timer = setInterval(() => {
      if (busy()) setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
  });
  onCleanup(() => {
    clearInterval(timer);
    controller?.abort();
  });
  const move = (index: number) => {
    if (index !== focus() && (index === 2 || index === 3))
      setValues((v) => ({ ...v, [fields[index]![0]]: "" }));
    if (index !== focus()) setConfirm(false);
    setFocus(index);
  };
  const stop = () => {
    controller?.abort();
    setConfirm(false);
  };
  const start = () => {
    if (busy()) return;
    if (!isolated()) {
      setMessage(
        "Confirm separate machine and independent local storage; no backup is created or downloaded.",
      );
      return;
    }
    if (!confirm()) {
      setConfirm(true);
      setMessage(
        "Confirm export from the existing snapshot. Missing coverage or unsupported privacy policy stops the export; no online fallback.",
      );
      return;
    }
    setConfirm(false);
    setBusy(true);
    setMessage("");
    setProgress(undefined);
    setElapsed(0);
    started = Date.now();
    controller = new AbortController();
    const v = values();
    const filters = Object.fromEntries(fields.slice(2, 13).map(([key]) => [key, v[key] ?? ""]));
    void Effect.runPromise(
      backend<{ count: number }>(
        {
          op: "offline",
          input: {
            snapshot: v.snapshot ?? "",
            coverage: v.coverage ?? "",
            isolatedBackup: isolated(),
            filters,
            path: v.path ?? "",
            format: formats[format()],
          },
        },
        setProgress,
        true,
      ),
      { signal: controller.signal },
    )
      .then((r) => setMessage(`Completed offline export: ${r.count} rows. File finalized.`))
      .catch((e) =>
        setMessage(
          controller?.signal.aborted
            ? "Cancelled. Previous destination preserved; partial file is not a completed result."
            : `Offline export failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
      .finally(() => setBusy(false));
  };
  const activate = () => {
    if (focus() === 14) setIsolated(!isolated());
    else if (focus() === 15) setFormat((format() + 1) % 4);
    else if (focus() === 16) start();
    else if (focus() === 17) stop();
    else if (focus() === 18 && !busy()) props.onBack();
  };
  useKeyboard((key) => {
    if (key.name === "tab") {
      key.preventDefault();
      move((focus() + (key.shift ? 18 : 1)) % 19);
    } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      stop();
    } else if (focus() >= 14 && ["return", "space"].includes(key.name)) {
      key.preventDefault();
      if (!busy() || focus() === 17) activate();
    }
  });
  return (
    <scrollbox
      ref={(value) => {
        scroll = value;
      }}
      flexGrow={1}
      scrollY>
      <box flexDirection="column" padding={1} gap={1}>
        <Section title="OFFLINE SNAPSHOT · NO API OR DNS">
          <text fg={theme.yellow}>
            Requires an existing consistent backup and coverage/policy metadata. No backup is
            assumed available.
          </text>
          <text fg={theme.muted}>
            Use another machine and independent local storage, never the DNS host, live database,
            UNC or shared production storage.
          </text>
          {fields.map(([key, label], index) => (
            <Field
              label={label}
              value={values()[key] ?? ""}
              focused={!busy() && focus() === index}
              onFocus={() => move(index)}
              onInput={(value) => {
                if (!busy()) {
                  setValues((v) => ({ ...v, [key]: value }));
                  setConfirm(false);
                }
              }}
            />
          ))}
        </Section>
        <ActionButton
          label={`ISOLATED BACKUP: ${isolated() ? "CONFIRMED" : "NOT CONFIRMED"}`}
          focused={focus() === 14}
          onFocus={() => move(14)}
          onPress={() => {
            if (!busy()) setIsolated(!isolated());
          }}
        />
        <ActionButton
          label={`FORMAT: ${formats[format()]!.toUpperCase()}`}
          focused={focus() === 15}
          onFocus={() => move(15)}
          onPress={() => {
            if (!busy()) setFormat((format() + 1) % 4);
          }}
        />
        <ActionButton
          label={busy() ? "EXPORTING…" : confirm() ? "CONFIRM OFFLINE EXPORT" : "EXPORT TO FILE"}
          focused={focus() === 16}
          onFocus={() => move(16)}
          onPress={start}
        />
        <ActionButton
          label="CANCEL"
          focused={focus() === 17}
          onFocus={() => move(17)}
          onPress={stop}
        />
        <ActionButton
          label="BACK TO API CONNECTION"
          focused={focus() === 18}
          onFocus={() => move(18)}
          onPress={() => {
            if (!busy()) props.onBack();
          }}
        />
        <text fg={theme.muted}>Logs: {logsDirectory()}</text>
        <text fg={theme.fg}>
          {busy()
            ? `Export in progress. Please don’t cancel. ${elapsed()}s · ${progress()?.phase ?? "validating"} · ${progress()?.rows ?? 0} processed rows`
            : message()}
        </text>
      </box>
    </scrollbox>
  );
}

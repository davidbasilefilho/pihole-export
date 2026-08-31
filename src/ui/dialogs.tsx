/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { ExportFormat, Query, QueryPreset } from "../lib/model";
import type { RefinableField } from "../lib/query";
import { ActionButton, Field, Modal, Segmented } from "./primitives";
import { theme } from "./theme";

export function ConfirmDialog(props: {
  readonly focus: number;
  readonly onFocus: (index: number) => void;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal title="HEAVY QUERY" color={theme.yellow} width="80%">
      <text>
        This query scans more than 2 days without an additional filter and may cause heavy disk I/O.
      </text>
      <box flexDirection="row" gap={1}>
        <ActionButton
          label="CONTINUE"
          focused={props.focus === 0}
          tone="primary"
          onFocus={() => props.onFocus(0)}
          onPress={props.onAccept}
        />
        <ActionButton
          label="CANCEL"
          focused={props.focus === 1}
          onFocus={() => props.onFocus(1)}
          onPress={props.onCancel}
        />
      </box>
    </Modal>
  );
}

export function SuggestionDialog(props: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  readonly selected: number;
  readonly focus: number;
  readonly onFocus: (index: number) => void;
  readonly onSelect: (index: number) => void;
  readonly onApply: () => void;
  readonly onMove: (delta: number) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal title={`PI-HOLE SUGGESTIONS · ${props.title}`}>
      <scrollbox
        flexGrow={1}
        maxHeight={18}
        scrollY
        onMouseScroll={(event) => props.onMove(event.scroll?.direction === "up" ? -1 : 1)}>
        <For each={props.items}>
          {(item, index) => (
            <box
              height={1}
              backgroundColor={index() === props.selected ? theme.blueDark : "transparent"}
              onMouseDown={() => {
                props.onFocus(0);
                if (index() === props.selected) props.onApply();
                else props.onSelect(index());
              }}>
              <text>
                {index() === props.selected ? "> " : "  "}
                {item}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
      <box flexDirection="row" gap={1}>
        <ActionButton
          label="APPLY"
          focused={props.focus === 1}
          tone="primary"
          onFocus={() => props.onFocus(1)}
          onPress={props.onApply}
        />
        <ActionButton
          label="CANCEL"
          focused={props.focus === 2}
          onFocus={() => props.onFocus(2)}
          onPress={props.onCancel}
        />
      </box>
    </Modal>
  );
}

const refineActions: ReadonlyArray<readonly [string, RefinableField]> = [
  ["FILTER DOMAIN", "domain"],
  ["FILTER CLIENT IP", "clientIp"],
  ["FILTER CLIENT NAME", "clientName"],
  ["FILTER UPSTREAM", "upstream"],
  ["FILTER TYPE", "type"],
  ["FILTER STATUS", "status"],
];

export function InspectDialog(props: {
  readonly row: Query;
  readonly focus: number;
  readonly onFocus: (index: number) => void;
  readonly onRefine: (field: RefinableField) => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal title={`QUERY ${props.row.id}`} width="90%">
      <scrollbox flexGrow={1} maxHeight={14} scrollY>
        <box flexDirection="column">
          <text>Time {new Date(props.row.time * 1000).toISOString()}</text>
          <text>Domain {props.row.domain}</text>
          <text>
            Client {props.row.client.ip} {props.row.client.name ?? ""}
          </text>
          <text>Type {props.row.type}</text>
          <text>Status {props.row.status ?? "—"}</text>
          <text>
            Reply {props.row.reply.type ?? "—"} · {props.row.reply.time} ms
          </text>
          <text>Upstream {props.row.upstream ?? "—"}</text>
          <text>DNSSEC {props.row.dnssec ?? "—"}</text>
          <text>CNAME {props.row.cname ?? "—"}</text>
          <text>
            EDE {props.row.ede.code} {props.row.ede.text ?? ""}
          </text>
        </box>
      </scrollbox>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <ActionButton
          label="CLOSE"
          focused={props.focus === 0}
          onFocus={() => props.onFocus(0)}
          onPress={props.onClose}
        />
        <For each={refineActions}>
          {([label, field], index) => (
            <ActionButton
              label={label}
              focused={props.focus === index() + 1}
              onFocus={() => props.onFocus(index() + 1)}
              onPress={() => props.onRefine(field)}
            />
          )}
        </For>
      </box>
    </Modal>
  );
}

export function SearchDialog(props: {
  readonly value: string;
  readonly focus: number;
  readonly onFocus: (index: number) => void;
  readonly onInput: (value: string) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal title="LOCAL RESULT SEARCH">
      <Field
        label="Search loaded results"
        value={props.value}
        focused={props.focus === 0}
        placeholder="domain, client, type, status…"
        onFocus={() => props.onFocus(0)}
        onInput={props.onInput}
        onSubmit={props.onApply}
      />
      <box flexDirection="row" gap={1}>
        <ActionButton
          label="APPLY"
          focused={props.focus === 1}
          tone="primary"
          onFocus={() => props.onFocus(1)}
          onPress={props.onApply}
        />
        <ActionButton
          label="CLEAR"
          focused={props.focus === 2}
          onFocus={() => props.onFocus(2)}
          onPress={props.onClear}
        />
        <ActionButton
          label="CANCEL"
          focused={props.focus === 3}
          onFocus={() => props.onFocus(3)}
          onPress={props.onCancel}
        />
      </box>
    </Modal>
  );
}

export function ExportDialog(props: {
  readonly path: string;
  readonly format: ExportFormat;
  readonly focus: number;
  readonly busy: boolean;
  readonly onFocus: (index: number) => void;
  readonly onPath: (value: string) => void;
  readonly onFormat: (value: ExportFormat) => void;
  readonly onExport: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal title="STREAM ALL MATCHING ROWS" color={theme.green}>
      <Segmented
        label="Format"
        values={["csv", "jsonl", "sqlite", "parquet"]}
        value={props.format}
        focused={props.focus === 0}
        onFocus={() => props.onFocus(0)}
        onSelect={props.onFormat}
      />
      <Field
        label="Local or UNC destination"
        value={props.path}
        focused={props.focus === 1}
        placeholder="queries.csv or \\server\share\queries.csv"
        onFocus={() => props.onFocus(1)}
        onInput={props.onPath}
        onSubmit={props.onExport}
      />
      <box flexDirection="row" gap={1}>
        <ActionButton
          label={props.busy ? "EXPORTING…" : "EXPORT"}
          focused={props.focus === 2}
          tone="success"
          onFocus={() => props.onFocus(2)}
          onPress={props.onExport}
        />
        <ActionButton
          label="CANCEL"
          focused={props.focus === 3}
          onFocus={() => props.onFocus(3)}
          onPress={props.onCancel}
        />
      </box>
    </Modal>
  );
}

export function PresetDialog(props: {
  readonly presets: ReadonlyArray<QueryPreset>;
  readonly name: string;
  readonly focus: number;
  readonly onFocus: (index: number) => void;
  readonly onName: (value: string) => void;
  readonly onSave: () => void;
  readonly onApply: (index: number) => void;
  readonly onDelete: (index: number) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal title="NON-SECRET QUERY PRESETS">
      <Field
        label="Preset name"
        value={props.name}
        focused={props.focus === 0}
        placeholder="Morning audit"
        onFocus={() => props.onFocus(0)}
        onInput={props.onName}
        onSubmit={props.onSave}
      />
      <box flexDirection="row" gap={1}>
        <ActionButton
          label="SAVE CURRENT"
          focused={props.focus === 1}
          tone="primary"
          onFocus={() => props.onFocus(1)}
          onPress={props.onSave}
        />
        <ActionButton
          label="CANCEL"
          focused={props.focus === 2}
          onFocus={() => props.onFocus(2)}
          onPress={props.onCancel}
        />
      </box>
      <scrollbox flexGrow={1} maxHeight={14} scrollY>
        <For each={props.presets}>
          {(preset, index) => (
            <box flexDirection="row" height={1} gap={1}>
              <ActionButton
                label={`LOAD ${preset.name}`}
                width={32}
                focused={props.focus === 3 + index() * 2}
                onFocus={() => props.onFocus(3 + index() * 2)}
                onPress={() => props.onApply(index())}
              />
              <ActionButton
                label="DELETE"
                focused={props.focus === 4 + index() * 2}
                tone="danger"
                onFocus={() => props.onFocus(4 + index() * 2)}
                onPress={() => props.onDelete(index())}
              />
            </box>
          )}
        </For>
      </scrollbox>
    </Modal>
  );
}

export function HelpDialog(props: { readonly onClose: () => void }) {
  return (
    <Modal title="HELP" color={theme.purple} width="80%">
      <scrollbox maxHeight={18} scrollY>
        <box flexDirection="column">
          <text>
            Tab / Shift+Tab traverse every control. Mouse click follows the same focus state.
          </text>
          <text>↑/↓, j/k navigate · Enter inspect/activate · mouse wheel scrolls lists.</text>
          <text>/ search · s sort · a aggregate · l live · x refine · e export · p presets.</text>
          <text>f filters · r rerun · ? help · Esc back/cancel · q quit.</text>
          <text>Ctrl+Space opens Pi-hole suggestions while editing a supported filter.</text>
        </box>
      </scrollbox>
      <ActionButton label="CLOSE" focused onPress={props.onClose} />
    </Modal>
  );
}

/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";

import type { FilterForm } from "../../lib/model";
import { ActionButton, Field, Section } from "../primitives";
import { theme } from "../theme";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function FilterScreen(props: {
  readonly width: number;
  readonly filters: Mutable<FilterForm>;
  readonly setFilters: SetStoreFunction<Mutable<FilterForm>>;
  readonly focus: number;
  readonly busy: boolean;
  readonly onFocus: (index: number) => void;
  readonly onPresets: () => void;
  readonly onSubmit: () => void;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  const narrow = () => props.width < 88;
  createEffect(() => {
    const focus = props.focus;
    const row = focus < 3 ? 0 : focus < 7 ? 4 : focus < 11 ? 8 : 12;
    scroll?.scrollTo(Math.max(0, row - 1));
  });
  const field = (
    index: number,
    key: keyof Pick<
      FilterForm,
      | "from"
      | "until"
      | "timezone"
      | "domain"
      | "clientIp"
      | "clientName"
      | "upstream"
      | "type"
      | "status"
      | "reply"
      | "dnssec"
    >,
    label: string,
    placeholder = "",
  ) => (
    <Field
      label={label}
      value={props.filters[key]}
      focused={props.focus === index}
      placeholder={placeholder}
      onFocus={() => props.onFocus(index)}
      onInput={(value) => props.setFilters(key, value)}
      onSubmit={props.onSubmit}
    />
  );
  return (
    <scrollbox ref={(value) => (scroll = value)} width="100%" flexGrow={1} scrollY>
      <box flexDirection="column" width="100%" padding={1} gap={1}>
        <Section title="DATE · TIME · TIMEZONE">
          <box flexDirection={narrow() ? "column" : "row"} gap={1}>
            {field(0, "from", "From · local (inclusive)")}
            {field(1, "until", "Until · local (exclusive)")}
            {field(2, "timezone", "Timezone (IANA)", "America/Sao_Paulo")}
          </box>
        </Section>
        <Section title="DOMAIN · CLIENT · UPSTREAM">
          <box flexDirection={narrow() ? "column" : "row"} gap={1}>
            {field(3, "domain", "Domain*", "Select or type…")}
            {field(4, "clientIp", "Client (IP)*", "Select or type…")}
            {field(5, "clientName", "Client (name)*", "Select or type…")}
            {field(6, "upstream", "Upstream*", "Select or type…")}
          </box>
        </Section>
        <Section title="DNS PROPERTIES">
          <box flexDirection={narrow() ? "column" : "row"} gap={1}>
            {field(7, "type", "Type", "Select or type…")}
            {field(8, "status", "Status", "Select or type…")}
            {field(9, "reply", "Reply", "Select or type…")}
            {field(10, "dnssec", "DNSSEC status", "Select or type…")}
          </box>
        </Section>
        <Section title="MODE · QUERY ACTION">
          <box flexDirection={narrow() ? "column" : "row"} gap={1}>
            <ActionButton
              label={props.filters.disk ? "ON-DISK: ON" : "ON-DISK: OFF"}
              focused={props.focus === 11}
              onFocus={() => props.onFocus(11)}
              onPress={() => props.setFilters("disk", !props.filters.disk)}
            />
            <ActionButton
              label="PRESETS"
              focused={props.focus === 12}
              onFocus={() => props.onFocus(12)}
              onPress={props.onPresets}
            />
            <ActionButton
              label={props.busy ? "QUERYING…" : "FETCH QUERIES"}
              focused={props.focus === 13}
              tone="primary"
              onFocus={() => props.onFocus(13)}
              onPress={props.onSubmit}
            />
          </box>
        </Section>
        <text fg={theme.muted}>* Manual input · * wildcard · Ctrl+Space suggestions</text>
      </box>
    </scrollbox>
  );
}

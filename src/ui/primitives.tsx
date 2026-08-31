/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js";

import { theme } from "./theme";

type Dimension = number | "auto" | `${number}%`;

export const fieldBackground = (focused: boolean) => (focused ? theme.bgHighlight : theme.bgStripe);

export function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly focused: boolean;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly width?: Dimension;
  readonly minWidth?: number;
  readonly flexGrow?: number;
  readonly onFocus: () => void;
  readonly onInput: (value: string) => void;
  readonly onSubmit?: () => void;
}) {
  return (
    <box
      flexDirection="column"
      height={2}
      flexGrow={props.flexGrow ?? 1}
      minWidth={props.minWidth ?? 18}
      onMouseDown={props.onFocus}
      {...(props.width === undefined ? {} : { width: props.width })}>
      <text fg={props.focused ? theme.cyan : theme.fg}>{props.label}</text>
      <box backgroundColor={fieldBackground(props.focused)} paddingLeft={1} height={1}>
        <input
          value={props.value}
          focused={props.focused}
          placeholder={props.placeholder ?? ""}
          width="100%"
          textColor={props.secret ? fieldBackground(props.focused) : theme.fg}
          focusedTextColor={props.secret ? fieldBackground(props.focused) : theme.fg}
          cursorColor={theme.blue}
          placeholderColor={theme.muted}
          onMouseDown={props.onFocus}
          onInput={(value) => props.onInput(value)}
          onSubmit={() => props.onSubmit?.()}
        />
        <text
          position="absolute"
          left={1}
          fg={theme.fg}
          content={props.secret === true ? "•".repeat(props.value.length) : ""}
        />
      </box>
    </box>
  );
}

export function ActionButton(props: {
  readonly label: string;
  readonly focused?: boolean;
  readonly tone?: "primary" | "success" | "danger";
  readonly width?: number;
  readonly onPress: () => void;
  readonly onFocus?: () => void;
}) {
  const background = () =>
    props.focused
      ? props.tone === "danger"
        ? theme.red
        : props.tone === "success"
          ? theme.green
          : theme.blue
      : theme.bgHighlight;
  return (
    <box
      height={1}
      width={props.width ?? Math.max(8, props.label.length + 2)}
      alignItems="center"
      justifyContent="center"
      backgroundColor={background()}
      onMouseDown={() => {
        props.onFocus?.();
        props.onPress();
      }}>
      <text fg={props.focused ? theme.bgDark : theme.fg}>{props.label}</text>
    </box>
  );
}

export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly values: ReadonlyArray<T>;
  readonly value: T;
  readonly focused: boolean;
  readonly labels?: Partial<Record<T, string>>;
  readonly onFocus: () => void;
  readonly onSelect: (value: T) => void;
}) {
  return (
    <box flexDirection="column" height={2}>
      <text fg={props.focused ? theme.cyan : theme.fg}>{props.label}</text>
      <box flexDirection="row" height={1}>
        <For each={props.values}>
          {(value) => (
            <box
              minWidth={12}
              height={1}
              flexGrow={1}
              alignItems="center"
              justifyContent="center"
              backgroundColor={props.value === value ? theme.blueDark : theme.bgStripe}
              onMouseDown={() => {
                props.onFocus();
                props.onSelect(value);
              }}>
              <text fg={props.value === value ? theme.green : theme.muted}>
                {props.labels?.[value] ?? value.toUpperCase()}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

export function Section(props: { readonly title: string; readonly children: JSX.Element }) {
  return (
    <box flexDirection="column" gap={1}>
      <box height={1} paddingLeft={1} backgroundColor={theme.bgHighlight}>
        <text fg={theme.purple}>{props.title}</text>
      </box>
      {props.children}
    </box>
  );
}

export function KeyBar(props: { readonly items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <box height={1} width="100%" flexDirection="row" backgroundColor={theme.bgHighlight}>
      <For each={props.items}>
        {([key, label]) => (
          <box flexDirection="row" paddingRight={1} gap={1}>
            <text fg={theme.yellow}>{key}</text>
            <text fg={theme.muted}>{label} │</text>
          </box>
        )}
      </For>
    </box>
  );
}

export function Modal(props: {
  readonly title: string;
  readonly color?: string;
  readonly width?: Dimension;
  readonly children: JSX.Element;
}) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      zIndex={1000}
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.bgDark}>
      <box
        width={props.width ?? "85%"}
        maxWidth={100}
        maxHeight="85%"
        flexDirection="column"
        backgroundColor={theme.bgHighlight}
        border
        borderColor={props.color ?? theme.blue}
        padding={1}
        gap={1}>
        <text fg={props.color ?? theme.cyan}>{props.title}</text>
        {props.children}
      </box>
    </box>
  );
}

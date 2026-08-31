/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect } from "solid-js";

import type { AuthMethod } from "../../lib/model";
import type { ConnectFocus } from "../focus";
import { ActionButton, Field, Section, Segmented, fieldBackground } from "../primitives";
import { theme } from "../theme";

export interface ConnectionScreenProps {
  readonly width: number;
  readonly host: string;
  readonly scheme: "http" | "https";
  readonly port: string;
  readonly authMethod: AuthMethod;
  readonly secret: string;
  readonly totp: string;
  readonly focus: ConnectFocus;
  readonly busy: boolean;
  readonly onFocus: (focus: ConnectFocus) => void;
  readonly onHost: (value: string) => void;
  readonly onScheme: (value: "http" | "https") => void;
  readonly onPort: (value: string) => void;
  readonly onAuth: (value: AuthMethod) => void;
  readonly onSecret: (value: string) => void;
  readonly onTotp: (value: string) => void;
  readonly onConnect: () => void;
}

export function ConnectionScreen(props: ConnectionScreenProps) {
  let scroll: ScrollBoxRenderable | undefined;
  const narrow = () => props.width < 72;
  createEffect(() => {
    const focus = props.focus;
    const row = ["host", "scheme", "port"].includes(focus)
      ? 0
      : focus === "auth"
        ? 4
        : focus === "connect"
          ? 9
          : 7;
    scroll?.scrollTo(Math.max(0, row - 1));
  });
  return (
    <scrollbox ref={(value) => (scroll = value)} width="100%" flexGrow={1} scrollY>
      <box flexDirection="column" width="100%" maxWidth={100} padding={1} gap={1}>
        <Section title="CONNECTION · AUTHENTICATE TO CONTINUE">
          <box flexDirection={narrow() ? "column" : "row"} gap={1}>
            <box
              flexDirection="column"
              height={2}
              width={narrow() ? "100%" : 14}
              minWidth={14}
              onMouseDown={() => props.onFocus("scheme")}>
              <text fg={props.focus === "scheme" ? theme.cyan : theme.fg}>Scheme</text>
              <box
                height={1}
                alignItems="center"
                justifyContent="center"
                backgroundColor={fieldBackground(props.focus === "scheme")}
                onMouseDown={() => {
                  props.onFocus("scheme");
                  props.onScheme(props.scheme === "http" ? "https" : "http");
                }}>
                <text fg={props.focus === "scheme" ? theme.yellow : theme.fg}>
                  {props.scheme.toUpperCase()} ◀▶
                </text>
              </box>
            </box>
            <Field
              label="Pi-hole IP / domain / full URL"
              value={props.host}
              focused={props.focus === "host"}
              placeholder="10.200.0.242 or https://pi.hole"
              onFocus={() => props.onFocus("host")}
              onInput={props.onHost}
              onSubmit={props.onConnect}
            />
            <Field
              label="Port (optional)"
              value={props.port}
              focused={props.focus === "port"}
              placeholder="80 / 443"
              width={narrow() ? "100%" : 18}
              minWidth={18}
              flexGrow={narrow() ? 1 : 0}
              onFocus={() => props.onFocus("port")}
              onInput={props.onPort}
              onSubmit={props.onConnect}
            />
          </box>
        </Section>
        <Section title="AUTHENTICATION">
          <Segmented
            label="Method"
            values={["password", "session", "none"]}
            value={props.authMethod}
            focused={props.focus === "auth"}
            labels={{ password: "PASSWORD", session: "SESSION ID", none: "NONE" }}
            onFocus={() => props.onFocus("auth")}
            onSelect={props.onAuth}
          />
          {props.authMethod === "none" ? null : (
            <box flexDirection={narrow() ? "column" : "row"} gap={1}>
              <Field
                label={
                  props.authMethod === "session"
                    ? "Existing session ID"
                    : "Admin / application password"
                }
                value={props.secret}
                focused={props.focus === "secret"}
                secret
                placeholder={props.authMethod === "session" ? "Session credential" : "Password"}
                onFocus={() => props.onFocus("secret")}
                onInput={props.onSecret}
                onSubmit={props.onConnect}
              />
              {props.authMethod === "password" ? (
                <Field
                  label="TOTP (optional)"
                  value={props.totp}
                  focused={props.focus === "totp"}
                  secret
                  placeholder="123456"
                  width={narrow() ? "100%" : 20}
                  minWidth={20}
                  flexGrow={narrow() ? 1 : 0}
                  onFocus={() => props.onFocus("totp")}
                  onInput={props.onTotp}
                  onSubmit={props.onConnect}
                />
              ) : null}
            </box>
          )}
        </Section>
        <box flexDirection={narrow() ? "column" : "row"} alignItems="center" gap={1}>
          <ActionButton
            label={props.busy ? "CONNECTING…" : "CONNECT"}
            focused={props.focus === "connect"}
            tone="primary"
            onFocus={() => props.onFocus("connect")}
            onPress={props.onConnect}
          />
          <text fg={theme.muted}>Credentials remain in memory only · TLS recommended off-host</text>
        </box>
      </box>
    </scrollbox>
  );
}

/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { QueryAnalytics } from "../../lib/analytics";
import type { Query } from "../../lib/model";
import type { ResultSort } from "../../lib/query";
import { resultActions } from "../focus";
import { ActionButton } from "../primitives";
import { tableHeader, tableLine } from "../table";
import { theme } from "../theme";

export function ResultsScreen(props: {
  readonly width: number;
  readonly height: number;
  readonly rows: ReadonlyArray<Query>;
  readonly selected: number;
  readonly busy: boolean;
  readonly aggregate: boolean;
  readonly analytics: QueryAnalytics;
  readonly search: string;
  readonly sort: ResultSort;
  readonly actionFocus: number;
  readonly onActionFocus: (index: number) => void;
  readonly onAction: (index: number) => void;
  readonly onSelect: (index: number) => void;
  readonly onInspect: () => void;
  readonly onMove: (delta: number) => void;
}) {
  const visible = () => {
    const count = Math.max(1, props.height - 8);
    const start = Math.max(
      0,
      Math.min(props.selected - Math.floor(count / 2), props.rows.length - count),
    );
    return props.rows.slice(start, start + count).map((row, offset) => ({
      row,
      index: start + offset,
    }));
  };
  const actionLabel = (action: (typeof resultActions)[number]) =>
    action === "SORT"
      ? `SORT: ${props.sort.toUpperCase()}`
      : action === "AGGREGATE"
        ? props.aggregate
          ? "RESULTS"
          : "AGGREGATE"
        : action;
  const aggregateColumn = (title: string, rows: QueryAnalytics["domains"]) => (
    <box flexDirection="column" flexGrow={1} minWidth={24}>
      <text fg={theme.cyan}>{title}</text>
      <For each={rows}>
        {(row) => <text>{`${String(row.count).padStart(7)}  ${row.value}`}</text>}
      </For>
    </box>
  );
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexWrap="wrap" gap={1} paddingLeft={1} paddingRight={1}>
        <For each={resultActions}>
          {(action, index) => (
            <ActionButton
              label={actionLabel(action)}
              focused={props.actionFocus === index()}
              tone="primary"
              onFocus={() => props.onActionFocus(index())}
              onPress={() => props.onAction(index())}
            />
          )}
        </For>
      </box>
      <box height={1} paddingLeft={1}>
        <text fg={theme.green}>
          {props.busy
            ? "FETCHING PAGES… Esc cancels"
            : `${props.rows.length.toLocaleString()} QUERIES${props.search ? ` · SEARCH “${props.search}”` : ""}`}
        </text>
      </box>
      {props.aggregate ? (
        <scrollbox flexGrow={1} scrollY>
          <box flexDirection="column" padding={1} gap={1}>
            <box flexDirection="row" flexWrap="wrap" gap={2}>
              <text fg={theme.green}>TOTAL {props.analytics.total.toLocaleString()}</text>
              <text fg={theme.red}>BLOCKED {props.analytics.blocked.toLocaleString()}</text>
              <text fg={theme.green}>ALLOWED {props.analytics.allowed.toLocaleString()}</text>
              <text fg={theme.yellow}>BLOCKED {props.analytics.blockedPercentage.toFixed(1)}%</text>
            </box>
            <box flexDirection={props.width < 80 ? "column" : "row"} gap={2}>
              {aggregateColumn("TOP DOMAINS", props.analytics.domains)}
              {aggregateColumn("TOP CLIENTS", props.analytics.clients)}
            </box>
            <box flexDirection={props.width < 80 ? "column" : "row"} gap={2}>
              {aggregateColumn("TOP UPSTREAMS", props.analytics.upstreams)}
              {aggregateColumn("QUERY TYPES", props.analytics.queryTypes)}
            </box>
          </box>
        </scrollbox>
      ) : (
        <box
          flexDirection="column"
          flexGrow={1}
          onMouseScroll={(event) => props.onMove(event.scroll?.direction === "up" ? -3 : 3)}>
          <box height={1} paddingLeft={1} backgroundColor={theme.bgHighlight}>
            <text fg={theme.green}>{tableHeader(props.width)}</text>
          </box>
          <For each={visible()}>
            {({ row, index }) => (
              <box
                height={1}
                paddingLeft={1}
                backgroundColor={
                  index === props.selected
                    ? theme.blueDark
                    : index % 2 === 0
                      ? theme.bg
                      : theme.bgStripe
                }
                onMouseDown={() => {
                  if (index === props.selected) props.onInspect();
                  else props.onSelect(index);
                }}>
                <text fg={theme.fg}>
                  {index === props.selected ? "> " : "  "}
                  {tableLine(row, props.width)}
                </text>
              </box>
            )}
          </For>
          {!props.busy && props.rows.length === 0 ? (
            <text fg={theme.muted}> No matching queries.</text>
          ) : null}
        </box>
      )}
    </box>
  );
}

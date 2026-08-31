import type { Query } from "../lib/model";

const truncate = (value: string, width: number) =>
  value.length > width ? value.slice(0, Math.max(0, width - 1)) + "…" : value.padEnd(width);

const layout = (width: number) => {
  if (width < 72)
    return {
      time: 19,
      domain: Math.max(8, width - 24),
      client: 0,
      type: 0,
      status: 0,
      reply: 0,
      upstream: 0,
    };
  const upstream = width >= 120 ? 20 : 0;
  const status = width >= 90 ? 12 : 0;
  const reply = width >= 90 ? 10 : 0;
  const client = 18;
  const type = 7;
  const used =
    20 +
    client +
    type +
    status +
    reply +
    upstream +
    [20, client, type, status, reply, upstream].filter((size) => size > 0).length -
    1;
  return { time: 20, domain: Math.max(8, width - used - 3), client, type, status, reply, upstream };
};

export const tableHeader = (width: number) => {
  const sizes = layout(width);
  return [
    truncate("TIMESTAMP", sizes.time),
    truncate("DOMAIN", sizes.domain),
    sizes.client > 0 ? truncate("CLIENT", sizes.client) : "",
    sizes.type > 0 ? truncate("TYPE", sizes.type) : "",
    sizes.status > 0 ? truncate("STATUS", sizes.status) : "",
    sizes.reply > 0 ? truncate("REPLY", sizes.reply) : "",
    sizes.upstream > 0 ? truncate("UPSTREAM", sizes.upstream) : "",
  ]
    .filter(Boolean)
    .join(" ");
};

export const tableLine = (row: Query, width: number) => {
  const sizes = layout(width);
  const time = new Date(row.time * 1000).toLocaleString(undefined, { hour12: false });
  return [
    truncate(time, sizes.time),
    truncate(row.domain, sizes.domain),
    sizes.client > 0 ? truncate(row.client.name ?? row.client.ip, sizes.client) : "",
    sizes.type > 0 ? truncate(row.type, sizes.type) : "",
    sizes.status > 0 ? truncate(row.status ?? "—", sizes.status) : "",
    sizes.reply > 0 ? truncate(row.reply.type ?? "—", sizes.reply) : "",
    sizes.upstream > 0 ? truncate(row.upstream ?? "—", sizes.upstream) : "",
  ]
    .filter(Boolean)
    .join(" ");
};

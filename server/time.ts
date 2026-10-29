export const TS_RE = /^\[?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]?/;
export const pad = (n: number) => String(n).padStart(2, "0");
export const toMs = (ts: string) => new Date(ts.replace(" ", "T")).getTime();
export const fmt = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
export const today = () => fmt(new Date()).slice(0, 10);
export const daysAgo = (n: number) => fmt(new Date(Date.now() - n * 86400000)).slice(0, 10);

import Table from 'cli-table3';
import pc from 'picocolors';

export { pc };

export function table(head: string[], rows: (string | number | undefined)[][]): string {
  const t = new Table({ head: head.map((h) => pc.bold(h)), style: { head: [], border: [] } });
  for (const r of rows) t.push(r.map((c) => (c === undefined || c === null ? '' : String(c))));
  return t.toString();
}

export function kv(pairs: [string, string | number | undefined][]): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${pc.dim(k.padEnd(width))}  ${v}`)
    .join('\n');
}

export function statusColor(status: string | undefined): string {
  if (!status) return '';
  if (/COMPLETED|SUCCESS|APPROVED|ENABLED/.test(status)) return pc.green(status);
  if (/FAIL|DENIED|BLOCKED|RETURNED|REFUNDED|REVERSED|CANCEL/.test(status)) return pc.red(status);
  return pc.yellow(status);
}

/** Finds a HATEOAS link by rel. */
export function link(obj: unknown, ...rels: string[]): string | undefined {
  const links = (obj as { links?: { rel: string; href: string }[] })?.links ?? [];
  for (const rel of rels) {
    const l = links.find((x) => x.rel === rel);
    if (l) return l.href;
  }
  return undefined;
}

export function ago(iso: string | undefined): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return iso;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// findings.md -> groups of bullets. Headings start groups; without headings, a leading ALL-CAPS tag ("BUG:", "UI:",
// "COST + SPEED:") groups the bullets. Text stays plain: the page escapes it and only turns `code` and **bold** on.

export type FindingItem = { text: string; sub: string[] };
export type FindingGroup = { title: string; items: FindingItem[] };
export type Findings = { groups: FindingGroup[]; raw: string };

const TAG = /^([A-Z][A-Z0-9 +&/-]*[A-Z0-9])(?:\s*\(([^)]*)\))?:\s+/;

export function parseFindings(md: string): Findings {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const headed: FindingGroup[] = [];
  const items: { item: FindingItem; heading: string | null }[] = [];
  let heading: string | null = null;
  let cur: FindingItem | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) items.push({ item: { text: para.join(" "), sub: [] }, heading });
    para = [];
  };
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      cur = null;
      heading = h[1].trim();
      continue;
    }
    const top = /^[-*]\s+(.*)$/.exec(line);
    if (top) {
      flush();
      cur = { text: top[1].trim(), sub: [] };
      items.push({ item: cur, heading });
      continue;
    }
    const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
    if (sub && cur) {
      cur.sub.push(sub[1].trim());
      continue;
    }
    if (!line.trim()) {
      flush();
      cur = null;
      continue;
    }
    // a wrapped line continues the bullet or sub-bullet above it
    if (cur && /^\s+/.test(line)) {
      if (cur.sub.length) cur.sub[cur.sub.length - 1] += ` ${line.trim()}`;
      else cur.text += ` ${line.trim()}`;
      continue;
    }
    cur = null;
    para.push(line.trim());
  }
  flush();
  const anyHeading = items.some((i) => i.heading);
  const groupOf = (i: { item: FindingItem; heading: string | null }) => {
    if (anyHeading) return i.heading ?? "Notes";
    const m = TAG.exec(i.item.text);
    if (!m) return "Notes";
    i.item.text = i.item.text.slice(m[0].length);
    i.item.text = i.item.text.charAt(0).toUpperCase() + i.item.text.slice(1);
    if (m[2]) i.item.text = `(${m[2]}) ${i.item.text}`;
    return m[1];
  };
  for (const i of items) {
    const title = groupOf(i);
    const g = headed.find((x) => x.title === title) ?? { title, items: [] };
    if (!headed.includes(g)) headed.push(g);
    g.items.push(i.item);
  }
  return { groups: headed, raw: md };
}

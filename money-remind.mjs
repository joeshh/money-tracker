// Money Tracker due-date reminder. Runs on GitHub Actions (see push-setup-money.md).
// Reads your private Gist (money-tracker-data / money.json), finds unpaid bills that are
// due soon or overdue, and sends ONE message to your ntfy topic.
const TOKEN = process.env.GIST_TOKEN;
const DRY = process.env.DRY === "1";
const LOCAL = process.env.MONEY_FILE; // only for testing on a computer
const NOW = process.env.FAKE_TODAY ? new Date(process.env.FAKE_TODAY + "T08:00:00+08:00") : new Date();

const gh = async (path) => {
  const r = await fetch("https://api.github.com" + path, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "money-remind" } });
  if (!r.ok) throw new Error("GitHub " + r.status + " for " + path);
  return r.json();
};

async function loadData() {
  if (LOCAL) return JSON.parse((await import("node:fs")).readFileSync(LOCAL, "utf8"));
  if (!TOKEN) throw new Error("Missing GIST_TOKEN secret");
  let g = null;
  for (let p = 1; p <= 10 && !g; p++) {
    const list = await gh("/gists?per_page=100&page=" + p);
    if (!list.length) break;
    g = list.find((x) => x.description === "money-tracker-data");
  }
  if (!g) throw new Error("Gist 'money-tracker-data' not found. Turn on cloud sync in the app first.");
  const full = await gh("/gists/" + g.id);
  const f = full.files && full.files["money.json"];
  if (!f) throw new Error("money.json is missing in the gist");
  const txt = f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content;
  return JSON.parse(txt);
}

const pad = (n) => String(n).padStart(2, "0");
// "today" in the Philippines (UTC+8)
const ph = new Date(NOW.getTime() + 8 * 3600 * 1000);
const today = Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth(), ph.getUTCDate());
const monthKey = (off) => { const d = new Date(Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth() + off, 1)); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1); };
const dueMs = (b, m) => {
  const y = +m.slice(0, 4), mo = +m.slice(5) - 1, dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return Date.UTC(y, mo, Math.min(+b.due, dim));
};
const peso = (n) => "₱" + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 });

const S = await loadData();
const nt = S.nt || {};
if (!nt.topic) { console.log("No ntfy topic set in the app (More → Notifications). Nothing to do."); process.exit(0); }
if (nt.due === false) { console.log("Due reminders are switched off in the app."); process.exit(0); }
const N = +nt.days > 0 ? +nt.days : 3;
const live = (S.tx || []).filter((t) => !t.x);
const paid = (b, m) => live.some((t) => t.bl === b.id && t.bm === m) || (S.paid && (b.id + "|" + m) in S.paid);

const lines = []; let urgent = false;
for (const b of S.bills || []) {
  if (!b.due) continue;
  [0, 1].forEach((off) => {
    const m = monthKey(off);
    if (paid(b, m)) return;
    const df = Math.round((dueMs(b, m) - today) / 864e5);
    const over = off === 0 && df < 0 && df >= -10;
    if (!(over || (df >= 0 && df <= N))) return;
    const amt = b.var ? (S.amt && S.amt[b.id + "|" + m] != null ? peso(S.amt[b.id + "|" + m]) : "amount not given yet") : peso(b.a || 0);
    const when = df < 0 ? "OVERDUE by " + -df + " day" + (-df === 1 ? "" : "s") : df === 0 ? "due TODAY" : "due in " + df + " day" + (df === 1 ? "" : "s");
    if (df <= 0) urgent = true;
    lines.push({ df, text: b.n + " · " + amt + " · " + when });
  });
}
if (!lines.length) { console.log("Nothing due within " + N + " days."); process.exit(0); }
lines.sort((a, b) => a.df - b.df);
const body = lines.map((l) => l.text).join("\n");
const srv = (nt.srv || "https://ntfy.sh").replace(/\/+$/, "");
if (DRY) { console.log("[dry run] would send to " + srv + "/" + nt.topic + "\n" + body); process.exit(0); }
const r = await fetch(srv + "/" + encodeURIComponent(nt.topic), { method: "POST", body, headers: { Title: urgent ? "Bills due or overdue" : "Bills due soon", Priority: urgent ? "4" : "3", Tags: urgent ? "warning" : "bell" } });
if (!r.ok) throw new Error("ntfy " + r.status);
console.log("Sent:\n" + body);

// 名古屋4館の上映スケジュールを公式サイトから取得して data.json を作る
// 実行: node scrape.mjs   （Node 20 以上、依存: cheerio）
import * as cheerio from "cheerio";
import fs from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const DAYS_AHEAD = 3; // 今日から何日先まで取るか

// 今日（日本時間）から DAYS_AHEAD 日先までの YYYYMMDD
const days = [];
for (let i = 0; i <= DAYS_AHEAD; i++) {
  const d = new Date(Date.now() + 9 * 3600e3 + i * 86400e3);
  days.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
}

async function get(url, { sjis = false, json = false } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  if (json) return r.json();
  if (sjis) return new TextDecoder("shift_jis").decode(await r.arrayBuffer());
  return r.text();
}

// 作品名を番号に置き換えて小さくまとめる
function packer() {
  const T = [], R = [];
  const ix = t => { let i = T.indexOf(t); if (i < 0) { T.push(t); i = T.length - 1; } return i; };
  const hhmm = s => { const m = String(s).match(/(\d{1,2}):?(\d\d)/); return m ? m[1].padStart(2, "0") + m[2] : ""; };
  return {
    add: (day, start, end, title, screen) => { if (title && hhmm(start)) R.push([day, hhmm(start), hhmm(end), ix(title), screen || ""].join(",")); },
    out: () => ({ T, R: R.join(";") }),
  };
}

// ---------- 109シネマズ名古屋 ----------
async function s109() {
  const p = packer();
  for (const d of days) {
    const $ = cheerio.load(await get(`https://109cinemas.net/nagoya/schedules/${d}.html?theater_code=A1`));
    const opt = {};
    $("option").each((_, o) => { opt[($(o).attr("value") || "").replace("#", "")] = $(o).text().trim(); });
    $("article").each((_, a) => {
      let ti = $(a).find("h2").first().text().trim();
      if (!ti) return;
      const o = opt[$(a).attr("id")];
      if (o && o.length > ti.length && !o.includes("…")) ti = o;
      let scr = "";
      $(a).find("ul.timetable li").each((_, li) => {
        if ($(li).hasClass("theatre")) { scr = $(li).find(".theatre-num").text().trim(); return; }
        const s = $(li).find("time.start").text().trim();
        if (s) p.add(d, s, $(li).find("time.end").text().trim(), ti, scr);
      });
    });
  }
  return p.out();
}

// ---------- TOHOシネマズ名古屋栄 ----------
async function sToho() {
  const p = packer();
  for (const d of days) {
    const $ = cheerio.load(await get(`https://hlo.tohotheater.jp/net/schedule/091/TNPI2160J01.do?site_cd=091&show_day=${d}`, { sjis: true }));
    $("div.movie-box").each((_, box) => {
      // 「日本語題　ENGLISH TITLE」から英題を落とす
      const segs = $(box).find("h4").first().text().trim().split("　");
      while (segs.length > 1 && /^[\x20-\x7E…]+$/.test(segs[segs.length - 1])) segs.pop();
      const ti = segs.join(" ").normalize("NFKC").trim();
      $(box).find("table.screen-list tr").each((_, tr) => {
        const scr = ($(tr).find("td.screen-name").text().match(/SCREEN\s*(\d+)/i) || [])[1] || "";
        $(tr).find("td.time-cell").each((_, td) => {
          const m = $(td).text().replace(/\s+/g, "").match(/(\d{1,2}:\d\d)-(\d{1,2}:\d\d)?/);
          if (m) p.add(d, m[1], m[2] || "", ti, scr);
        });
      });
    });
  }
  return p.out();
}

// ---------- ミッドランドスクエアシネマ（1・2） ----------
async function sMidland() {
  const p = packer();
  for (const d of days) {
    let html;
    try { html = await get(`https://ticket.midlandcinema.jp/schedule/schedule/pc/s0100_0201_${d}-1.html?t=${Date.now()}`); }
    catch (e) { if (/^404/.test(e.message)) continue; throw e; }
    const $ = cheerio.load(html);
    $(".scheduleBox").each((_, box) => {
      const ti = $(box).find("h2").first().text().trim();
      if (!ti) return;
      $(box).find("p[class^=ScreenGroup]").each((_, pe) => {
        const scr = $(pe).text().trim().normalize("NFKC").replace(/^スクリーン/, "").replace(/[【\s].*$/, "");
        $(pe).parent().find("span.fontXL").each((_, sp) => {
          const end = ($(sp).parent().text().match(/～\s*(\d{1,2}:\d\d)/) || [])[1] || "";
          p.add(d, $(sp).text().trim(), end, ti, scr);
        });
      });
    });
  }
  return p.out();
}

// ---------- イオンシネマワンダー ----------
async function sAeon() {
  const p = packer();
  const s = await get(`https://theater.aeoncinema.com/schedule/v2/data/wonder/schedule.json?v=${Date.now()}`, { json: true });
  for (const d of days) {
    const o = s[d];
    if (!o) continue;
    const base = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 9 * 3600e3; // その日の0時(JST)
    const fm = iso => { const m = Math.round((new Date(iso).getTime() - base) / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
    for (const k in o) for (const e of o[k]) {
      p.add(d, fm(e.startDate), fm(e.endDate), e.name?.ja, (e.location?.name?.ja || "").replace("スクリーン", ""));
    }
  }
  return p.out();
}

// ---------- 実行 ----------
const prev = fs.existsSync("data.json") ? JSON.parse(fs.readFileSync("data.json", "utf8")) : null;
const jobs = { "109": s109, toho: sToho, msc: sMidland, aeon: sAeon };
const theaters = {}, status = {};
for (const [id, fn] of Object.entries(jobs)) {
  try {
    const r = await fn();
    const n = r.R ? r.R.split(";").length : 0;
    if (!n) throw new Error("上映データが0件");
    theaters[id] = r; status[id] = "ok";
    console.log(`${id}: ${n} 回`);
  } catch (e) {
    // 失敗した館は前回データのうち対象日付だけ残す
    const old = prev?.theaters?.[id];
    theaters[id] = old ? { T: old.T, R: old.R.split(";").filter(r => days.includes(r.split(",")[0])).join(";") } : { T: [], R: "" };
    status[id] = "failed";
    console.error(`${id}: 取得失敗 → 前回データを使用 (${e.message})`);
  }
}
// ---------- ジャンル判定（TMDB + 手動の genre.txt） ----------
// 作品名から形式表記（字幕・IMAX・舞台挨拶など）を外して作品の本体名にする（index.html と同じ処理）
const FW = /字幕|吹替|IMAX|Dolby|ドルビー|SCREENX|4DX|轟音|4K|最速|舞台挨拶|赤ちゃん|応援|発声|ODS|SAION|ライブビューイング|リマスター|レストア|^DC/i;
function baseTitle(raw) {
  let s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  s = s.replace(/【(PG|R)-?\d+\+?指定】/g, "");
  s = s.replace(/\[([^\]]*)(\]|$)/g, (m, x) => FW.test(x) ? "" : m);
  s = s.replace(/【([^】]*)】/g, (m, x) => FW.test(x) ? "" : m);
  s = s.replace(/\(([^)]*)(\)|$)/g, (m, x) => FW.test(x) ? "" : m);
  s = s.replace(/^(字幕|吹替)\s+/, "");
  s = s.replace(/^舞台挨拶中継付き\)\s*/, "");
  s = s.replace(/(公開記念)?舞台挨拶.*$/, (m, a, off) => off > 0 ? "" : m);
  let m;
  if (m = s.match(/^劇場アニメーション[「『](.+?)[」』]\s*(.*)$/)) s = m[1];
  else if ((m = s.match(/^(.*?)『(.+?)』(.*)$/)) && (m[1].trim() === "" || /劇場版|上映$/.test(m[1].trim()))) s = m[2];
  s = s.replace(/\s4K(リマスター|レストア)?(?=\s|\(|$)/, "");
  return s.trim().replace(/(…|\.\.\.)$/, "").trim();
}
const keyOf = s => s.normalize("NFKC").toLowerCase().replace(/^(映画|劇場版)\s*/, "").replace(/[^\p{L}\p{N}]/gu, "");

// 映画ではないもの（ライブ・スポーツ・舞台など）は名前で判定
const OTHER = /WORLD TOUR|\bLIVE\b|ライヴ|ライブ|コンサート|歌舞伎|METライブ|ナショナル・シアター|ビューイング|サッカー|ワールドカップ|CHEERING|ANIAFF|カンファレンス/i;

// TMDB 検索用に作品名を整える
function queries(base) {
  const q = base.replace(/^(映画|劇場版|劇場先行版|劇場シリーズ|劇場アニメーション)\s*/, "")
    .replace(/【[^】]*】|「|」|『|』|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const list = [q];
  const short = q.split(/[\s/:：~～\-ー―]/)[0];               // 副題を落とした短い名前
  if (short && short.length >= 2 && short !== q) list.push(short);
  return list;
}

async function tmdbGenre(base) {
  const token = process.env.TMDB_TOKEN;
  if (!token) return null;
  const want = keyOf(base);
  for (const q of queries(base)) {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}&language=ja-JP&include_adult=false`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    const res = (await r.json()).results || [];
    if (!res.length) continue;
    // 題名がいちばん近いもの → なければ人気順の先頭
    const hit = res.find(x => keyOf(x.title || "") === want || keyOf(x.original_title || "") === want)
      || res.find(x => want.startsWith(keyOf(x.title || "")) && keyOf(x.title || "").length >= 2)
      || res[0];
    const g = (hit.genre_ids || []).includes(16) ? "アニメ"      // 16 = Animation
      : hit.original_language === "ja" ? "邦画" : "洋画";
    return { g, tmdb: hit.id, title: hit.title, q };
  }
  return null;
}

const CACHE_FILE = "genre-cache.json";
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const manualText = fs.existsSync("genre.txt") ? fs.readFileSync("genre.txt", "utf8") : "";
const manual = new Set(manualText.split("\n").map(l => keyOf(baseTitle(l.trim()))).filter(Boolean));
const todayStr = days[0];
const weekAgo = new Date(Date.now() + 9 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10).replace(/-/g, "");
const bases = new Map();
for (const t of Object.values(theaters)) for (const raw of t.T) { const b = baseTitle(raw); if (b) bases.set(keyOf(b), b); }
let looked = 0;
for (const [k, b] of bases) {
  if (!k || manual.has(k)) continue;                                // 手動指定があればそちらを使う
  const c = cache[k];
  if (c && (c.g || (c.checked && c.checked > weekAgo))) continue; // 判定済み／見つからなかったものは7日後に再検索
  let entry;
  if (OTHER.test(b)) entry = { g: "その他", by: "name" };
  else {
    try { const r = await tmdbGenre(b); entry = r ? { ...r, by: "tmdb" } : { g: null }; looked++; }
    catch (e) { console.error(`TMDB検索失敗: ${b} (${e.message})`); continue; }
  }
  cache[k] = { name: b, ...entry, checked: todayStr };
  console.log(`ジャンル: ${b} → ${entry.g || "不明"}${entry.title ? `（TMDB: ${entry.title}）` : ""}`);
}
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
if (!process.env.TMDB_TOKEN) console.warn("TMDB_TOKEN が未設定のため、TMDB でのジャンル判定は行いませんでした");
else console.log(`TMDB 検索: ${looked} 件`);

// 自動判定 → 手動（genre.txt）の順に並べる。ページ側は後に書いたものを優先する
const auto = { "アニメ": [], "邦画": [], "洋画": [], "その他": [] };
for (const c of Object.values(cache)) if (c.g && auto[c.g]) auto[c.g].push(c.name);
const genre = Object.entries(auto).map(([g, l]) => [g, ...l].join("\n")).join("\n") + "\n" + manualText;

const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
fs.writeFileSync("data.json", JSON.stringify({ updated: now, days, theaters, status, genre }));
console.log(`data.json を書き出しました (${now} JST, ${days[0]}〜${days.at(-1)})`);
if (Object.values(status).every(s => s === "failed")) process.exit(1);

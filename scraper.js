// scraper.js
// AppointmentTrader "Recently Posted Requests" -> Discord webhook
// Node 20+, ESM ("type":"module" in package.json)

import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { chromium } from "playwright";

// ----------------- Config -----------------
const PAGE_URL = "https://appointmenttrader.com/concierge";

const STATE_VERSION = "v1";
const STATE_FILE = `./state.${STATE_VERSION}.json`;

const WEBHOOK        = process.env.DISCORD_WEBHOOK_URL;
const FIRST_RUN      = String(process.env.FIRST_RUN ?? "true").toLowerCase() === "true";
const SEED_IF_EMPTY  = String(process.env.SEED_IF_EMPTY ?? "true").toLowerCase() === "true";
const DEBUG_LOG      = String(process.env.DEBUG_LOG ?? "false").toLowerCase() === "true";

const MAX_ITEMS         = 20;
const STATE_TTL_DAYS    = 14;
const DISCORD_DELAY_MS  = 750;
const HYDRATION_WAIT_MS = 2500;

// ----------------- State helpers -----------------
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { version: STATE_VERSION, initialized: false, sent: {} };
    if (!parsed.sent || typeof parsed.sent !== "object") parsed.sent = {};
    if (!("initialized" in parsed)) parsed.initialized = false;
    if (!parsed.version) parsed.version = STATE_VERSION;
    return parsed;
  } catch {
    return { version: STATE_VERSION, initialized: false, sent: {} };
  }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function pruneOld(state) {
  const cutoff = Date.now() - STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [k, ts] of Object.entries(state.sent)) {
    if (typeof ts !== "number" || ts < cutoff) { delete state.sent[k]; removed++; }
  }
  if (removed) console.log(`Pruned ${removed} old entries from state.`);
}

// ----------------- Hashing (backward compatible) -----------------
const norm = s => (s || "").replace(/\s+/g, " ").trim();
const sha = s => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// v3 (current, stable): focuses on durable fields
function hashV3(it) {
  const canon = {
    p: norm(it.price || ""),
    u: norm(it.user  || ""),
    d: norm(it.desc  || "").slice(0, 200),
    w: norm(it.when  || ""),
    l: norm(it.link  || "")
  };
  return sha(JSON.stringify(canon));
}

// v2 (previous trending version): title+desc+when+price+link
function hashV2(it) {
  const canon = {
    t: norm(it.title || ""),
    d: norm(it.desc  || "").slice(0, 200),
    w: norm(it.when  || ""),
    p: norm(it.price || ""),
    l: norm(it.link  || "")
  };
  return sha(JSON.stringify(canon));
}

// v1 (very early version): title+meta+when+price+link
function hashV1(it) {
  const canon = {
    t: norm(it.title || ""),
    m: norm(it.meta  || ""),  // may be empty for current items
    w: norm(it.when  || ""),
    p: norm(it.price || ""),
    l: norm(it.link  || "")
  };
  return sha(JSON.stringify(canon));
}

function candidateIds(it) {
  // Primary id first; legacy ids after
  return [hashV3(it), hashV2(it), hashV1(it)];
}

function markAllHashes(state, it, ts = Date.now()) {
  for (const id of candidateIds(it)) state.sent[id] = ts;
}

function isAlreadySeen(state, it) {
  const ids = candidateIds(it);
  for (const id of ids) if (state.sent[id]) return { seen: true, existingId: id, primary: ids[0] };
  return { seen: false, existingId: null, primary: ids[0] };
}

function migrateToPrimaryIfNeeded(state, seenInfo) {
  const { seen, existingId, primary } = seenInfo;
  if (seen && !state.sent[primary]) {
    state.sent[primary] = state.sent[existingId]; // migrate silently
  }
}

// ----------------- Discord -----------------
async function postToDiscord(items) {
  for (const it of items) {
    const titleBits = [];
    if (it.price) titleBits.push(it.price);
    if (it.user)  titleBits.push(`by ${it.user}`);
    const title = titleBits.length ? titleBits.join(" — ") : (it.title || "New Request");

    const content = [
      `**${title}**`,
      it.desc ? `> ${it.desc}` : null,
      it.when ? `**When:** ${it.when}` : null,
      it.link || PAGE_URL
    ].filter(Boolean).join("\n");

    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("Discord post failed:", res.status, txt);
    } else {
      console.log("Posted:", title);
    }
    await new Promise(r => setTimeout(r, DISCORD_DELAY_MS));
  }
}

async function postSummaryToDiscord(items) {
  if (!items.length) {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ℹ️ Initial seed: no requests visible right now." })
    });
    return;
  }

  const header = `✅ Initial seed: **${items.length}** current request(s) found`;
  const lines = items.map((it) => {
    const titleBits = [];
    if (it.price) titleBits.push(it.price);
    if (it.user)  titleBits.push(`by ${it.user}`);
    const title = titleBits.length ? titleBits.join(" — ") : "Request";
    const snippet = it.desc ? it.desc.slice(0, 140) + (it.desc.length > 140 ? "…" : "") : "";
    return [`• **${title}**`, snippet ? `— ${snippet}` : null, `\n${it.link || PAGE_URL}`]
      .filter(Boolean)
      .join(" ");
  });

  const chunks = [];
  let buf = header + "\n\n";
  for (const ln of lines) {
    if ((buf + ln + "\n\n").length > 1900) { chunks.push(buf.trimEnd()); buf = ""; }
    buf += ln + "\n\n";
  }
  if (buf.trim()) chunks.push(buf.trimEnd());

  for (const content of chunks) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("Discord summary post failed:", res.status, txt);
    }
    await new Promise(r => setTimeout(r, DISCORD_DELAY_MS));
  }
}

// ----------------- Scraping -----------------
async function scrapeFromTrending(page) {
  const section = page
    .locator(".home-trending-section:has(.home-trending-title span:has-text('Recently Posted Requests'))")
    .first();

  if (!(await section.count())) {
    console.warn("Trending section not found; returning empty list.");
    return [];
  }

  const rows = section.locator(".home-trending-searches .home-trending-item");
  const count = await rows.count();
  const limit = Math.min(count, MAX_ITEMS);

  const out = [];
  for (let i = 0; i < limit; i++) {
    const row = rows.nth(i);

    const textRaw = await row.innerText().catch(() => "");
    const text = norm(textRaw);
    if (!text) continue;

    const onclick = await row.getAttribute("onclick").catch(() => null);

    // prefer visible URL; otherwise try to decode from onclick base64
    let link = null;
    const visibleUrl = text.match(/https?:\/\/[^\s)]+/i);
    if (visibleUrl) link = visibleUrl[0];
    else if (onclick) {
      const m = onclick.match(/DecodeText\('([^']+)'/);
      if (m && m[1]) {
        try {
          const decoded = Buffer.from(m[1], "base64").toString("utf8");
          const urlInDecoded = decoded.match(/https?:\/\/[^\s)]+/i);
          if (urlInDecoded) link = urlInDecoded[0];
        } catch {}
      }
    }
    if (!link) link = PAGE_URL;

    const price = (text.match(/\$\s*[\d,]+\s*reward/i) || [])[0]?.replace(/\s*reward/i, "") || "";
    const userMatch = text.match(/posted by\s+([^:]+):/i);
    const user = userMatch ? norm(userMatch[1]) : "";
    const colonIdx = text.indexOf(":");
    const desc = colonIdx >= 0 ? norm(text.slice(colonIdx + 1)) : "";
    const when =
      (text.match(/\b(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i) || [])[0] ||
      (text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i) || [])[0] ||
      (text.match(/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i) || [])[0] || "";

    out.push({
      title: `${price || "Request"} — ${user || "user"}`,
      meta: "", // legacy field (v1) stays empty for modern rows
      user, price, desc, when, link
    });
  }
  return out;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });
  const page = await ctx.newPage();

  try {
    console.log("Navigating to:", PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(HYDRATION_WAIT_MS);

    const items = await scrapeFromTrending(page);

    if (DEBUG_LOG) {
      console.log(`Parsed ${items.length} trending item(s):`);
      for (const it of items) console.log(`• ${it.price} by ${it.user} — ${it.link}`);
    }
    return items;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ----------------- Main -----------------
async function main() {
  try {
    if (!WEBHOOK) {
      console.error("Missing DISCORD_WEBHOOK_URL env var.");
      process.exitCode = 1;
      return;
    }

    const state = loadState();
    pruneOld(state);

    const items = await scrape();

    // Safety: if cache empty but not first run, seed silently
    const empty = !state.initialized && Object.keys(state.sent).length === 0;
    if (empty && !FIRST_RUN && SEED_IF_EMPTY) {
      console.log("State empty and FIRST_RUN=false → seeding silently (no Discord).");
      for (const it of items) markAllHashes(state, it);
      state.initialized = true;
      state.version = STATE_VERSION;
      state.initialized_at = new Date().toISOString();
      saveState(state);
      return;
    }

    // FIRST RUN: post summary then seed all hash variants
    if (FIRST_RUN && !state.initialized) {
      console.log("FIRST_RUN=true and state not initialized → posting summary of current items.");
      await postSummaryToDiscord(items);
      for (const it of items) markAllHashes(state, it);
      state.initialized = true;
      state.version = STATE_VERSION;
      state.initialized_at = new Date().toISOString();
      saveState(state);
      return;
    }

    // Migration: if any legacy hash exists, add the primary v3 id (silent, no post)
    for (const it of items) {
      const info = isAlreadySeen(state, it);
      if (info.seen) migrateToPrimaryIfNeeded(state, info);
    }

    // Normal: post only truly new items
    const fresh = [];
    for (const it of items) {
      const info = isAlreadySeen(state, it);
      if (!info.seen) { markAllHashes(state, it); fresh.push(it); }
    }

    if (!fresh.length) {
      console.log("No new items.");
      saveState(state);
      return;
    }

    console.log(`Posting ${fresh.length} new request(s) to Discord…`);
    await postToDiscord(fresh);
    saveState(state);
  } catch (err) {
    console.error("Fatal error:", err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}

main();

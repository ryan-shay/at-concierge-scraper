// scraper.js
// AppointmentTrader "Recently Posted Requests" -> Discord webhook
// Node 20+, ESM ("type":"module" in package.json)

import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { chromium } from "playwright";
import { URL as NodeURL } from "node:url";

// =====================
// Config
// =====================
const PAGE_URL = "https://appointmenttrader.com/concierge";

// bump to invalidate old state file names
const STATE_VERSION = "v1";
const STATE_FILE = `./state.${STATE_VERSION}.json`;

const WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
const FIRST_RUN = String(process.env.FIRST_RUN ?? "true").toLowerCase() === "true";
const DEBUG_LOG = String(process.env.DEBUG_LOG ?? "false").toLowerCase() === "true";

const MAX_ITEMS         = 20;   // max cards to parse/post per run
const STATE_TTL_DAYS    = 14;   // prune old hashes
const DISCORD_DELAY_MS  = 750;  // ms between posts
const HYDRATION_WAIT_MS = 2500; // ms after DOMContentLoaded

// =====================
// State helpers
// =====================
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
function hashItem(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

// =====================
// Discord
// =====================
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

// =====================
// Scraping (Playwright)
// =====================
// Strictly scope to the exact container shown in your snippet:
// .home-trending-section that has a .home-trending-title span "Recently Posted Requests",
// then read rows from .home-trending-searches > .home-trending-item
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

    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!text) continue;

    const onclick = await row.getAttribute("onclick").catch(() => null);

    // pick URL: prefer visible text URL, else decode from onclick's DecodeText('...')
    let link = null;
    const visibleUrl = text.match(/https?:\/\/[^\s)]+/i);
    if (visibleUrl) {
      link = visibleUrl[0];
    } else if (onclick) {
      const m = onclick.match(/DecodeText\('([^']+)'/);
      if (m && m[1]) {
        try {
          const decoded = Buffer.from(m[1], "base64").toString("utf8");
          const urlInDecoded = decoded.match(/https?:\/\/[^\s)]+/i);
          if (urlInDecoded) link = urlInDecoded[0];
        } catch { /* ignore bad base64 */ }
      }
    }
    if (!link) link = PAGE_URL;

    // parse fields
    const price = (text.match(/\$\s*[\d,]+\s*reward/i) || [])[0]?.replace(/\s+reward/i, "") || "";
    const userMatch = text.match(/posted by\s+([^:]+):/i);
    const user = userMatch ? userMatch[1].trim() : "";

    // description is everything after the first colon
    const colonIdx = text.indexOf(":");
    const desc = colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : "";

    // heuristics for when
    const when =
      (text.match(/\b(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i) || [])[0] ||
      (text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i) || [])[0] ||
      (text.match(/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i) || [])[0] || "";

    out.push({
      title: `${price || "Request"} — ${user || "user"}`,
      user,
      price,
      desc,
      when,
      link
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
      for (const it of items) {
        console.log(`• ${it.price} by ${it.user} — ${it.link}`);
      }
    }

    return items;
  } finally {
    await browser.close().catch(() => {});
  }
}

// =====================
// Main
// =====================
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

    if (FIRST_RUN && !state.initialized) {
      console.log("FIRST_RUN=true and state not initialized → posting summary of current items.");
      await postSummaryToDiscord(items);

      // seed state with everything currently visible
      for (const it of items) {
        const id = hashItem({ t: it.title, d: it.desc, w: it.when, p: it.price, l: it.link });
        state.sent[id] = Date.now();
      }
      state.initialized = true;
      state.version = STATE_VERSION;
      state.initialized_at = new Date().toISOString();
      saveState(state);
      return;
    } else if (FIRST_RUN && state.initialized) {
      console.log("FIRST_RUN=true but state already initialized → normal run.");
    }

    // Normal run: post only new ones
    const newOnes = [];
    for (const it of items) {
      const id = hashItem({ t: it.title, d: it.desc, w: it.when, p: it.price, l: it.link });
      if (!state.sent[id]) { state.sent[id] = Date.now(); newOnes.push(it); }
    }

    if (!newOnes.length) {
      console.log("No new items.");
      saveState(state);
      return;
    }

    console.log(`Posting ${newOnes.length} new request(s) to Discord…`);
    await postToDiscord(newOnes);
    saveState(state);
  } catch (err) {
    console.error("Fatal error:", err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}

main();

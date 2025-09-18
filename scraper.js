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
    const content = [
      `**${it.title || "New Request"}**`,
      it.meta ? `> ${it.meta}` : null,
      it.when ? `**When:** ${it.when}` : null,
      it.price ? `**Bounty:** ${it.price}` : null,
      it.link ? it.link : PAGE_URL
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
      console.log("Posted:", it.title || it.link);
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
    const bits = [
      `• ${it.price || "—"} by **${it.user || "unknown"}**`,
      it.desc ? `— ${it.desc.slice(0, 120)}${it.desc.length > 120 ? "…" : ""}` : null
    ].filter(Boolean).join(" ");
    return `${bits}\n${it.link || PAGE_URL}`;
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
// We deliberately use a DOM evaluation scoped BELOW the
// "Recently Posted Requests" header and require the phrase
// "reward posted by" so we ignore nav/marketing blocks.
async function scrapeItems(page) {
  // returns array of { text, hrefs[] } extracted from the correct section
  return await page.evaluate((maxItems) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    // 1) Find the header node
    const allEls = Array.from(document.querySelectorAll("h1,h2,h3,div,section,span,header,p,strong"));
    const header = allEls.find(el => /Recently Posted Requests/i.test(el.textContent || ""));

    // Helper: is A after B in the DOM?
    const isAfter = (a, b) => !!(b && (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));

    // 2) Collect candidate nodes AFTER the header that contain the target phrase
    const nodes = Array.from(document.querySelectorAll("li, .list-group-item, .card, .row, .request, [data-request], a, div"));
    const items = [];
    const seenTexts = new Set();

    for (const n of nodes) {
      if (header && !isAfter(n, header)) continue;

      const txt = norm(n.textContent);
      if (!/reward posted by/i.test(txt)) continue;                // must look like a request row
      if (/Become a Concierge/i.test(txt)) continue;               // skip the header row button
      if (txt.length < 20 || txt.length > 4000) continue;          // sanity

      // dedupe by normalized text to avoid nested duplicates
      const key = txt.slice(0, 400);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);

      const hrefs = Array.from(n.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(h => !!h);

      items.push({ text: txt, hrefs });
      if (items.length >= maxItems) break;
    }
    return items;
  }, MAX_ITEMS);
}

// Parse a raw item object into structured fields
function parseItem(raw) {
  const text = raw.text;
  const reward = (text.match(/\$\s*[\d,]+/g) || [])[0] || "";

  // posted by USER:
  let user = "";
  const mUser = text.match(/posted by\s+([^:]+):/i);
  if (mUser) user = mUser[1].trim();

  // description: after the first colon (post-user)
  let desc = "";
  const colonIdx = text.indexOf(":");
  if (colonIdx !== -1) desc = text.slice(colonIdx + 1).trim();

  // choose a link: prefer external link (not appointmenttrader.com), else first link, else PAGE_URL
  let link = PAGE_URL;
  if (Array.isArray(raw.hrefs) && raw.hrefs.length) {
    const external = raw.hrefs.find(h => !/appointmenttrader\.com/i.test(h));
    link = external || raw.hrefs[0] || PAGE_URL;
  }

  // Optional heuristics for "when"
  const when =
    (text.match(/\b(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i) || [])[0] ||
    (text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i) || [])[0] ||
    (text.match(/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i) || [])[0] || "";

  return {
    title: `${reward || "Request"} posted by ${user || "user"}`,
    meta: desc ? desc.slice(0, 140) : "",
    when,
    price: reward || "",
    link,
    user,
    desc
  };
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

    const raw = await scrapeItems(page);
    const parsed = raw.map(parseItem);

    if (DEBUG_LOG) {
      console.log(`Parsed ${parsed.length} item(s):`);
      for (const it of parsed) console.log(`• ${it.price} by ${it.user} — ${it.link}`);
    }

    return parsed;
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
        const id = hashItem({ t: it.title, m: it.meta, w: it.when, p: it.price, l: it.link });
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
      const id = hashItem({ t: it.title, m: it.meta, w: it.when, p: it.price, l: it.link });
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

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

// Bump this if you ever want to invalidate existing state without touching caches
const STATE_VERSION = "v1";
const STATE_FILE = `./state.${STATE_VERSION}.json`;

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// FIRST_RUN behavior:
// - Default true (so the first deploy posts what it sees once).
// - After first successful run, set to "false" in your workflow env.
const FIRST_RUN = String(process.env.FIRST_RUN ?? "true").toLowerCase() === "true";

// Optional verbose logs (scraped items, etc.)
const DEBUG_LOG = String(process.env.DEBUG_LOG ?? "false").toLowerCase() === "true";

const MAX_ITEMS = 20;           // cap how many cards we parse per run
const STATE_TTL_DAYS = 14;      // prune old hashes
const DISCORD_DELAY_MS = 750;   // throttle between webhook posts
const HYDRATION_WAIT_MS = 2500; // wait after DOMContentLoaded

// =====================
// State helpers
// =====================
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { version: STATE_VERSION, initialized: false, sent: {} };
    if (!parsed.sent || typeof parsed.sent !== "object") parsed.sent = {};
    if (!parsed.version) parsed.version = STATE_VERSION;
    if (typeof parsed.initialized !== "boolean") parsed.initialized = false;
    return parsed;
  } catch {
    return { version: STATE_VERSION, initialized: false, sent: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function pruneOld(state) {
  const cutoff = Date.now() - STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [k, ts] of Object.entries(state.sent)) {
    if (typeof ts !== "number" || ts < cutoff) {
      delete state.sent[k];
      removed++;
    }
  }
  if (removed) console.log(`Pruned ${removed} old entries from state.`);
}
function hashItem(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

// =====================
// Discord helpers
// =====================
async function postToDiscord(items) {
  // Post one message per item (normal mode)
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

// Send a compact summary on FIRST_RUN (minimizes spam; handles 2000-char limit)
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
      `• **${it.title || "Request"}**`,
      it.when ? `(${it.when})` : null,
      it.price ? `— ${it.price}` : null
    ].filter(Boolean).join(" ");
    const url = it.link || PAGE_URL;
    return `${bits}\n${url}`;
  });

  // Chunk into multiple messages if >2000 chars
  const chunks = [];
  let buf = header + "\n\n";
  for (const ln of lines) {
    if ((buf + ln + "\n\n").length > 1900) {
      chunks.push(buf.trimEnd());
      buf = "";
    }
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
// Use ONLY Locators; iterate with .count() + .nth() to avoid malformed selector issues.
async function extractCards(page) {
  let container = page.locator(
    "section:has-text('Recently Posted Requests'), " +
    "div:has-text('Recently Posted Requests'), " +
    "section:has-text('Recently Posted'), " +
    "div:has-text('Recently Posted')"
  );

  let cards = container.locator("a[href], .card, li, .row, .request, [data-request]");
  let count = await cards.count();

  if (count === 0) {
    console.warn("Header container not found; using page-wide heuristics.");
    cards = page.locator("a[href], .card, li, .row, .request, [data-request]");
    count = await cards.count();
  }

  const list = [];
  const limit = Math.min(count, MAX_ITEMS);
  for (let i = 0; i < limit; i++) list.push(cards.nth(i));
  return list; // array of Locators
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

    const cardLocators = await extractCards(page);
    console.log(`Found ${cardLocators.length} candidate cards.`);

    const results = [];
    for (const card of cardLocators) {
      const text = (await card.innerText().catch(() => "")).trim();
      if (!text) continue;

      // Prefer own href; otherwise find first child link
      let href = await card.getAttribute("href").catch(() => null);
      if (!href) {
        const childA = card.locator("a[href]").first();
        if (await childA.count()) href = await childA.getAttribute("href").catch(() => null);
      }

      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
      const title = lines[0] || "Request";
      const meta = lines.slice(1, 3).join(" • ") || "";
      const when =
        lines.find(l =>
          /(\d{1,2}:\d{2}\s*(AM|PM)?)|Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December/i.test(l)
        ) || "";
      const price = lines.find(l => /\$|bounty|offer|reward/i.test(l)) || "";
      const link = href ? (href.startsWith("http") ? href : new NodeURL(href, PAGE_URL).toString()) : PAGE_URL;

      // Basic noise filter
      if (!/request|reserve|reservation|table|booking|bounty|offer|help/i.test(text)) continue;

      results.push({ title, meta, when, price, link });
      if (results.length >= MAX_ITEMS) break;
    }

    if (DEBUG_LOG) {
      console.log(`Parsed ${results.length} item(s):`);
      for (const it of results) {
        console.log(`• ${it.title} | ${it.when} | ${it.price} | ${it.link}`);
      }
    }

    return results;
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

    // FIRST RUN MODE: always post a summary of what we currently see,
    // then mark all of them as sent and set initialized=true.
    if (FIRST_RUN && !state.initialized) {
      console.log("FIRST_RUN=true and state not initialized → posting summary of current items.");
      await postSummaryToDiscord(items);

      // Write all current items into state so future runs dedupe
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
      console.log("FIRST_RUN=true but state already initialized; acting as normal run to avoid duplicates.");
    }

    // Normal mode: dedup and post only new ones
    const newOnes = [];
    for (const it of items) {
      const id = hashItem({ t: it.title, m: it.meta, w: it.when, p: it.price, l: it.link });
      if (!state.sent[id]) {
        state.sent[id] = Date.now();
        newOnes.push(it);
      }
    }

    if (!newOnes.length) {
      console.log("No new items.");
      saveState(state); // still save in case pruning happened
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

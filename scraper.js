// scraper.js
// AppointmentTrader "Recently Posted Requests" -> Discord webhook
// Node 20+, ESM ("type":"module" in package.json)

import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { chromium } from "playwright";
import { URL as NodeURL } from "node:url";

// ---- Config ----
const PAGE_URL   = "https://appointmenttrader.com/concierge";
const STATE_FILE = "./state.json";
const WEBHOOK    = process.env.DISCORD_WEBHOOK_URL;

const MAX_ITEMS = 20;           // cap how many cards we parse/post per run
const STATE_TTL_DAYS = 14;      // prune old hashes
const DISCORD_DELAY_MS = 750;   // throttle between webhook posts
const HYDRATION_WAIT_MS = 2500; // wait after DOMContentLoaded

// ---- State helpers ----
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.sent ? parsed : { sent: {} };
  } catch { return { sent: {} }; }
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

// ---- Discord ----
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

// ---- Scraping ----
// Use ONLY Locators; iterate with .count() + .nth() to avoid the malformed selector issue.
async function extractCards(page) {
  // Try containers that include the header text
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

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- Main ----
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

    // Dedup by hash
    const newOnes = [];
    for (const it of items) {
      const id = hashItem({ t: it.title, m: it.meta, w: it.when, p: it.price, l: it.link });
      if (!state.sent[id]) { state.sent[id] = Date.now(); newOnes.push(it); }
    }

    if (!newOnes.length) {
      console.log("No new items.");
      saveState(state); // still persist pruning
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

// scraper.js
// AppointmentTrader "Recently Posted Requests" -> Discord webhook
// Runtime: Node 20+, ESM ("type":"module" in package.json)

import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { chromium } from "playwright";
import { URL as NodeURL } from "node:url"; // avoid shadowing the global URL symbol

// ---- Config ----
const PAGE_URL   = "https://appointmenttrader.com/concierge";
const STATE_FILE = "./state.json";
const WEBHOOK    = process.env.DISCORD_WEBHOOK_URL;

// How many items to consider from the page (keeps noise down)
const MAX_ITEMS = 20;

// Delete sent-hash entries older than this many days (keeps state.json small)
const STATE_TTL_DAYS = 14;

// Throttle between Discord posts (ms)
const DISCORD_DELAY_MS = 750;

// Give the page time to hydrate after DOMContentLoaded (ms)
const HYDRATION_WAIT_MS = 2500;

// ---- Helpers ----
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // basic shape guard
    if (!parsed || typeof parsed !== "object" || !parsed.sent) return { sent: {} };
    return parsed;
  } catch {
    return { sent: {} };
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

async function postToDiscord(items) {
  for (const it of items) {
    const content = [
      `**${it.title || "New Request"}**`,
      it.meta ? `> ${it.meta}` : null,
      it.when ? `**When:** ${it.when}` : null,
      it.price ? `**Bounty:** ${it.price}` : null,
      it.link ? it.link : PAGE_URL
    ]
      .filter(Boolean)
      .join("\n");

    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("Discord post failed:", res.status, txt);
    } else {
      console.log("Posted to Discord:", it.title || it.link);
    }

    await new Promise((r) => setTimeout(r, DISCORD_DELAY_MS));
  }
}

// Try a few selector strategies so minor page tweaks don't break us
async function extractCards(page) {
  // Primary: section/div that literally contains the header text
  const containers = await page
    .locator(
      [
        "section:has-text('Recently Posted Requests')",
        "div:has-text('Recently Posted Requests')",
        // fallback near matches
        "section:has-text('Recently Posted')",
        "div:has-text('Recently Posted')"
      ].join(", ")
    )
    .elementHandles();

  const candidateLocators = [];

  if (containers.length) {
    for (const el of containers) {
      const loc = page.locator(":scope", { has: el });
      candidateLocators.push(loc.locator("a, .card, li, .row, .request, [data-request]"));
    }
  } else {
    console.warn("Header container not found; using page-wide heuristics.");
    candidateLocators.push(
      page.locator("a:has-text('request'), a:has-text('Request'), .card, li, .row")
    );
  }

  // Collect unique element handles from all candidate locators
  const handles = [];
  for (const loc of candidateLocators) {
    const hs = await loc.elementHandles();
    for (const h of hs) handles.push(h);
  }
  return handles.slice(0, MAX_ITEMS);
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

    // Give client-side hydration a moment (site is likely SPA-ish)
    await page.waitForTimeout(HYDRATION_WAIT_MS);

    const cards = await extractCards(page);
    console.log(`Found ${cards.length} candidate cards.`);

    const results = [];
    for (const card of cards) {
      const text = (await card.innerText().catch(() => "")).trim();
      // Prefer anchor href if this element is an <a>, otherwise check descendants
      let href =
        (await card.getAttribute?.("href").catch(() => null)) ||
        (await card.$eval?.("a", (a) => a.getAttribute("href")).catch(() => null)) ||
        null;

      if (!text) continue;

      // Heuristic parse
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const title = lines[0] || "Request";
      const meta = lines.slice(1, 3).join(" • ") || "";

      const when =
        lines.find((l) =>
          /(\d{1,2}:\d{2}\s*(AM|PM)?)|Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December/i.test(
            l
          )
        ) || "";

      const price = lines.find((l) => /\$|bounty|offer|reward/i.test(l)) || "";

      const link = href
        ? (href.startsWith("http") ? href : new NodeURL(href, PAGE_URL).toString())
        : PAGE_URL;

      // Filter obvious non-request noise
      if (!/request|reserve|reservation|table|booking|bounty|offer|help/i.test(text)) continue;

      results.push({ title, meta, when, price, link });
      if (results.length >= MAX_ITEMS) break;
    }

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}

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

    // Deduplicate by content hash
    const newOnes = [];
    for (const it of items) {
      const id = hashItem({
        t: it.title,
        m: it.meta,
        w: it.when,
        p: it.price,
        l: it.link
      });
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

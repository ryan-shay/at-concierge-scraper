import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { chromium } from "playwright";

const PAGE_URL = "https://appointmenttrader.com/concierge"
const STATE_FILE = "./state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { sent: {} }; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function hashItem(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

async function postToDiscord(items) {
  // Post one message per item; keep it short & structured
  for (const it of items) {
    const content = [
      `**${it.title || "New Request"}**`,
      it.meta ? `> ${it.meta}` : null,
      it.when ? `**When:** ${it.when}` : null,
      it.price ? `**Bounty:** ${it.price}` : null,
      it.link ? it.link : URL
    ].filter(Boolean).join("\n");

    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("Discord post failed:", res.status, txt);
    }
    await new Promise(r => setTimeout(r, 750)); // gentle rate limit
  }
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // In case content is hydrated after load, give it a moment.
  await page.waitForTimeout(2000);

  // Adjust selectors after quick inspection if needed:
  // We’ll look for a block/list containing "Recently Posted Requests"
  const section = await page.locator("text=Recently Posted Requests").first();
  if (!await section.count()) {
    // fallback: just scan for cards that look like requests
    console.warn("Could not find the specific header; scanning for request cards…");
  }

  // Heuristic: get cards/rows under/near that header
  // Try common patterns; update selectors if the site’s DOM differs.
  const cards = await page.locator("section:has-text('Recently Posted Requests'), div:has-text('Recently Posted Requests')").locator("a, .card, li, .row").all();

  const results = [];
  for (const card of cards) {
    const text = (await card.innerText().catch(()=>""))?.trim();
    const href = (await card.getAttribute?.("href").catch(()=>null)) || null;
    if (!text) continue;

    // Extract heuristics
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const title = lines[0] || "Request";
    const meta = lines.slice(1,3).join(" • ") || "";
    // naive pulls for when/price; tweak as needed after first run
    const when = lines.find(l => /(\d{1,2}:\d{2}|Today|Tomorrow|AM|PM|[A-Za-z]{3,9}\s+\d{1,2})/i) || "";
    const price = lines.find(l => /\$|bounty|offer|reward/i) || "";

    const link = href ? (href.startsWith("http") ? href : new URL(href, PAGE_URL).toString()) : PAGE_URL;

    // Filter obvious non-request noise by keywords
    if (!/request|reserve|table|booking|bounty|offer|help/i.test(text)) continue;

    results.push({ title, meta, when, price, link });
    if (results.length >= 15) break; // we only need the Recents
  }

  await browser.close();
  return results;
}

async function main() {
  if (!WEBHOOK) {
    console.error("Missing DISCORD_WEBHOOK_URL env var.");
    process.exit(1);
  }

  const state = loadState();
  const items = await scrape();

  // Dedup via hash
  const newOnes = [];
  for (const it of items) {
    const id = hashItem({ t: it.title, m: it.meta, w: it.when, p: it.price, l: it.link });
    if (!state.sent[id]) {
      state.sent[id] = Date.now();
      newOnes.push(it);
    }
  }

  if (newOnes.length) {
    console.log(`Posting ${newOnes.length} new request(s) to Discord…`);
    await postToDiscord(newOnes);
    saveState(state);
  } else {
    console.log("No new items.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});



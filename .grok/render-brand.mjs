import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.goto("file:///workspace/.grok/og-card.html", { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const metrics = await page.evaluate(() => {
  const title = document.querySelector(".title");
  const mark = document.querySelector(".mark");
  const tb = title.getBoundingClientRect();
  const mb = mark.getBoundingClientRect();
  return {
    font: getComputedStyle(title).fontFamily,
    title: { x: tb.x, y: tb.y, w: tb.width, h: tb.height },
    mark: { x: mb.x, y: mb.y, w: mb.width, h: mb.height },
    text: title.textContent,
  };
});
console.log(JSON.stringify(metrics, null, 2));
await page.screenshot({ path: "/workspace/.grok/og-raw.png", type: "png" });

const icon = await browser.newPage({
  viewport: { width: 256, height: 256 },
  deviceScaleFactor: 1,
});
await icon.goto("file:///workspace/.grok/favicon.svg", { waitUntil: "load" });
await icon.screenshot({ path: "/workspace/.grok/favicon-256.png", type: "png" });

const tiny = await browser.newPage({
  viewport: { width: 32, height: 32 },
  deviceScaleFactor: 1,
});
await tiny.goto("file:///workspace/.grok/favicon.svg", { waitUntil: "load" });
await tiny.screenshot({ path: "/workspace/.grok/favicon-32.png", type: "png" });

await browser.close();

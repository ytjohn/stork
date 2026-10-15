import { chromium } from "@playwright/test";
const OUT = "/home/user/paperkite-hq/stork/audit/pwa-agent/screenshots";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("http://127.0.0.1:13300/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-inbox-390x844.png` });
// overflow check
const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log("inbox overflow", JSON.stringify(ov));
// open sidebar drawer
const menuBtn = page.locator("button[aria-label*='menu' i], button[title*='menu' i], button[aria-label*='sidebar' i]").first();
if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/02-sidebar-drawer-390x844.png` }); await page.keyboard.press("Escape"); await page.mouse.click(380, 400); await page.waitForTimeout(400); }
else console.log("no menu button found");
// open first message
const item = page.locator("[data-message-id], [role='listitem'], li").first();
await page.locator("text=/./").first();
const rows = page.locator("button[data-index]");
console.log("rows", await rows.count());
const target = (await rows.count()) ? rows.nth(0) : item;
await target.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/03-thread-390x844.png` });
const ov2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log("thread overflow", JSON.stringify(ov2));
// compose via 'c' shortcut
await page.goBack().catch(() => {});
await page.waitForTimeout(800);
await page.keyboard.press("c");
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/04-compose-390x844.png` });
// manifest / sw checks
const pwa = await page.evaluate(async () => ({
  manifestLink: !!document.querySelector("link[rel='manifest']"),
  themeColor: !!document.querySelector("meta[name='theme-color']"),
  swSupported: "serviceWorker" in navigator,
  swRegs: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? null,
}));
console.log("pwa", JSON.stringify(pwa));
const swTry = await page.evaluate(async () => { try { await navigator.serviceWorker.register("/sw.js"); return "registered"; } catch (e) { return String(e); } });
console.log("sw register attempt:", swTry);
console.log("console errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

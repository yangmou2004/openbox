/** 单独截几张卡片，用来肉眼检查图表细节。 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const CACHED_CHROME = path.join(
  process.env.LOCALAPPDATA || "",
  "ms-playwright",
  "chromium-1243",
  "chrome-win64",
  "chrome.exe"
);

(async () => {
  const browser = await chromium.launch({
    ...(fs.existsSync(CACHED_CHROME) ? { executablePath: CACHED_CHROME } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.goto("file://" + path.join(__dirname, "harness.html").replace(/\\/g, "/"));
  await page.waitForSelector(".sidebar");
  await page.waitForTimeout(500);

  // 按 .card-title 精确匹配 —— 用 :has-text 会被包含关系串台（「开箱趋势」会命中「出货趋势」）
  // 看板首屏（筛选面板 + 领读条 + 统计卡）
  await page.screenshot({ path: path.join(SHOTS, "board-top.png") });
  console.log("shot board-top");

  const grab = async (name, title) => {
    const card = page.locator(".card", { has: page.locator(`.card-title:text-is("${title}")`) }).first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await card.screenshot({ path: path.join(SHOTS, `card-${name}.png`) });
    console.log("shot", name);
  };

  await grab("trend", "开箱趋势");
  await grab("stack", "各箱型的船型构成");
  await grab("time", "出货趋势");
  await grab("heatmap", "箱型 × 船型 出货分布");
  await grab("rank", "各箱型的开箱占比");

  // 悬浮提示
  const bar = page.locator(".trend-bar").nth(3);
  if (await bar.count()) {
    await bar.hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, "card-trend-tip.png") });
    console.log("shot trend-tip");
  }

  // 赫罗图…不，悬停热力矩阵
  await page.locator(".hm-cell:not(.is-zero)").first().hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "card-heatmap-tip.png") });

  await browser.close();
})();

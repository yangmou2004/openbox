/**
 * 用真实 Chromium 跑一遍界面，验证 5 条需求是否真的落地，并截图存档。
 * 只读 _app_src 与 _tools，不碰打包产物。
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* 本机缓存的是 chromium-1243，而 playwright 1.64 默认要 1248。
   直接用缓存里那个可执行文件，免得为了截图再下一次浏览器。 */
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

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto("file://" + path.join(__dirname, "harness.html").replace(/\\/g, "/"));
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  await page.waitForTimeout(400);

  /* ── 看板 ─────────────────────────────────────────────────────────────── */
  await page.screenshot({ path: path.join(SHOTS, "1-board.png"), fullPage: true });

  const boardHasTrend = await page.locator(".trend-cols svg").count();
  check("看板有船型趋势图", boardHasTrend === 1, `svg count=${boardHasTrend}`);

  // 必须是折线图
  const trendLines = await page.locator(".trend-cols svg polyline").count();
  check("趋势图是折线图", trendLines === 1, `polyline=${trendLines}`);

  // 八档的取值顺序（从下到上）
  const tierKeys = await page.$$eval("[data-trend-tier]", (els) =>
    els.map((e) => e.dataset.trendTier)
  );
  const wantKeys = [
    "frigate",
    "destroyer",
    "fighter",
    "escort",
    "cruiser",
    "support",
    "battlecruiser",
    "carrier"
  ];
  check(
    "需求5 趋势图档位顺序 护卫→驱逐→战机→护航→巡洋→支援→战巡→航母",
    JSON.stringify(tierKeys) === JSON.stringify(wantKeys),
    `实际=${tierKeys.join(" / ")}`
  );

  // 需求：船型在 Y 轴。Y 轴标签要贴在绘图区左边，且从下往上是升序
  const geom = await page.evaluate(() => {
    const svg = document.querySelector(".trend-cols svg");
    const labels = [...svg.querySelectorAll("[data-trend-tier]")].map((e) => {
      const b = e.getBBox();
      return { key: e.dataset.trendTier, x: b.x + b.width, y: b.y + b.height / 2 };
    });
    const hits = [...svg.querySelectorAll(".trend-hit")].map((e) => {
      const b = e.getBBox();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    });
    return { labels, hits };
  });
  const allLeft = geom.labels.every((l) => l.x < Math.min(...geom.hits.map((h) => h.cx)));
  // SVG 的 y 向下增大，所以「自下而上升序」= 随着档位升高，标签的 y 递减。
  // 最低档（护卫）必须落在最下面，也就是 y 最大的那个。
  const ascending = geom.labels.every((l, i) => i === 0 || l.y < geom.labels[i - 1].y);
  const lowestIsBottom = geom.labels[0].y === Math.max(...geom.labels.map((l) => l.y));
  check(
    "需求 船型排在 Y 轴（绘图区左侧，最低档在下、最高档在上）",
    allLeft && ascending && lowestIsBottom,
    `都在左侧=${allLeft} 自下而上升序=${ascending} 护卫在最下=${lowestIsBottom}`
  );

  // 每条记录一个数据点
  const hitCount = await page.locator(".trend-cols svg .trend-hit").count();
  const totalRecords = Number(await page.locator(".nav-count").innerText());
  check("趋势图每条记录一个数据点", hitCount === totalRecords, `点=${hitCount} 记录=${totalRecords}`);

  // 横轴 = 记录顺序，从左到右由老到新
  const seq = await page.$$eval("[data-trend-time]", (els) =>
    els.map((e) => ({
      t: Number(e.dataset.trendTime),
      x: Number(e.dataset.trendX),
      i: Number(e.dataset.trendSeq)
    }))
  );
  const timeUp = seq.every((p, i) => i === 0 || p.t >= seq[i - 1].t);
  const xUp = seq.every((p, i) => i === 0 || p.x > seq[i - 1].x);
  const idxOk = seq.every((p, i) => p.i === i);
  check(
    "X 轴由老到新（时间递增、位置右移）",
    timeUp && xUp && idxOk,
    `时间递增=${timeUp} 位置右移=${xUp} 序号连续=${idxOk}`
  );

  // 横轴刻度是「第几笔」，不是日期
  const ticks = await page.$$eval("[data-trend-tick]", (els) =>
    els.map((e) => ({ label: e.textContent.trim(), n: Number(e.dataset.trendTick) }))
  );
  const allNumeric = ticks.every((t) => /^\d+$/.test(t.label) && Number(t.label) === t.n);
  const tickAsc = ticks.every((t, i) => i === 0 || t.n > ticks[i - 1].n);
  check(
    "X 轴刻度是 1/2/3 这样的序号（不是日期）",
    allNumeric && tickAsc && ticks[0]?.n === 1 && ticks.at(-1)?.n === totalRecords,
    `${ticks.map((t) => t.label).join(", ")}（首=${ticks[0]?.label} 末=${ticks.at(-1)?.label} / 共 ${totalRecords}）`
  );

  // SVG 的 <text> 不是 HTMLElement，innerText 读不了，得走 textContent
  const xAxisCaption = await page.$$eval(".trend-cols svg text", (els) => {
    const hit = els.find((e) => e.textContent.includes("第几笔"));
    return hit ? hit.textContent.trim() : "";
  });
  check("X 轴说明写的是第几笔", xAxisCaption.includes("老 → 新"), xAxisCaption || "(没找到)");

  const noteText = (await page.locator(".trend-order-note").innerText()).replace(/\s+/g, "");
  check("需求5 顺序说明文字存在", noteText.startsWith("低→护卫→驱逐→战机"), noteText);

  /* ── 大船 = 巡洋 / 战巡 / 航母 / 支援（原来是「稀有」，只算前三档） ────── */
  const bigMarks = await page.$$eval("[data-trend-tier]", (els) =>
    els.filter((e) => e.textContent.includes("大船")).map((e) => e.dataset.trendTier)
  );
  check(
    "支援也算大船（趋势图 Y 轴标了四档）",
    JSON.stringify(bigMarks) === JSON.stringify(["cruiser", "support", "battlecruiser", "carrier"]),
    bigMarks.join(" / ") || "(一个都没标)"
  );

  const onlyBigBtn = (await page.locator('[data-act="rare-only"]').innerText()).trim();
  const bigTile = await page.locator(".stat-label", { hasText: "大船出货率" }).count();
  const heroSub = await page.locator(".hero-sub").innerText();
  check(
    "统计卡、横幅、筛选栏都改叫「大船」",
    onlyBigBtn === "只看大船" && bigTile === 1 && heroSub.includes("大船"),
    `按钮=${onlyBigBtn} 统计卡=${bigTile} 顶部=${heroSub.trim()}`
  );

  // 一句话兜底：整个看板上不该再出现「稀有」两个字
  const boardText = await page.locator(".main").innerText();
  check("看板上不再出现「稀有」字样", !boardText.includes("稀有"), boardText.includes("稀有") ? "还有残留" : "干净");

  // 只算大船时，支援那档的点要留下；「只看大船」筛选出来的条数应等于四档之和
  const expectedBig = await page.evaluate(() => {
    const ships = ["cruiser", "battlecruiser", "carrier", "support"];
    return window.__mock
      .allOf(window.__mock.activeId())
      .filter((r) => ships.includes(r.shipType)).length;
  });
  await page.click('[data-act="rare-only"]');
  await page.waitForTimeout(400);
  const shownBig = Number((await page.locator(".hero-value").innerText()).trim());
  check("「只看大船」筛出的条数 = 四档之和", shownBig === expectedBig, `筛出 ${shownBig}，应为 ${expectedBig}`);
  await page.click('[data-act="rare-only"]');
  await page.waitForTimeout(300);

  // 需求 3：页面级容器在主轴居中。
  // 注意不能把 .chart-grid 里的 .card 也算进来 —— 那些是两列网格里的左右格，
  // 本来就该一左一右，拿它们量「居中」只会量出半格宽。
  const centering = await page.evaluate(() => {
    const main = document.querySelector(".main").getBoundingClientRect();
    const zels = document.querySelectorAll(
      ".view, .view-title, .dashboard, .filter-bar, .hero, .stat-grid, .chart-grid, .entry-form, .record-list, .settings-view, .settings-block, .db-row"
    );
    return [...zels].map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.className, diff: Math.abs(r.left - main.left - (main.right - r.right)) };
    });
  });
  const worst = centering.reduce((a, b) => (b.diff > a.diff ? b : a));
  check("需求3 看板页面级容器水平居中", worst.diff <= 2, `最差 ${worst.diff.toFixed(1)}px (${worst.cls})`);

  // 表格视图兜底（需求 5 的图也要有）
  await page.click('[data-act="view"][data-key="shipTrend"][data-value="table"]');
  await page.waitForTimeout(200);
  const tableRows = await page.locator(".card:has-text('开箱趋势') .data-table tbody tr").count();
  const trendTitle = await page
    .locator(".card", { has: page.locator('.card-title:text-is("开箱趋势")') })
    .count();
  check(
    "需求5 趋势图标题是「开箱趋势」且有数据表视图",
    trendTitle === 1 && tableRows === 9,
    `标题=${trendTitle} 表行=${tableRows}`
  );
  await page.screenshot({ path: path.join(SHOTS, "2-board-trend-table.png"), fullPage: true });
  await page.click('[data-act="view"][data-key="shipTrend"][data-value="chart"]');
  await page.waitForTimeout(200);

  /* ── 录入 ─────────────────────────────────────────────────────────────── */
  await page.click('[data-act="tab"][data-tab="entry"]');
  await page.waitForSelector('[data-act="form-ship"]');
  await page.waitForTimeout(250);

  const labelBefore = (await page.locator('[data-role="type-label"]').innerText()).trim();
  check("需求4 出蓝=否 时字段叫「蓝点类型」", labelBefore === "蓝点类型", `实际="${labelBefore}"`);

  // 八档是按钮铺开选的，不是收在下拉里
  const choiceCount = await page.locator('[data-act="form-ship"]').count();
  const selectCount = await page.locator("select[data-field='shipType']").count();
  check("需求4 八档用按钮选择（不是下拉）", choiceCount === 8 && selectCount === 0, `按钮=${choiceCount} 下拉=${selectCount}`);

  const choiceLabels = await page.$$eval('[data-act="form-ship"]', (els) =>
    els.map((e) => e.textContent.trim())
  );
  check(
    "需求4 选项内容正确",
    JSON.stringify(choiceLabels) === JSON.stringify(["战机", "护卫", "护航", "驱逐", "巡洋", "战巡", "航母", "支援"]),
    choiceLabels.join("/")
  );

  // 点了要真的选中
  await page.click('[data-act="form-ship"][data-value="cruiser"]');
  await page.waitForTimeout(250);
  const cruiserActive = await page
    .locator('[data-act="form-ship"][data-value="cruiser"]')
    .evaluate((e) => e.classList.contains("is-active"));
  const fighterActive = await page
    .locator('[data-act="form-ship"][data-value="fighter"]')
    .evaluate((e) => e.classList.contains("is-active"));
  check("点某一档就选中它、并取消别的", cruiserActive && !fighterActive, `巡洋选中=${cruiserActive} 战机仍选中=${fighterActive}`);

  await page.screenshot({ path: path.join(SHOTS, "3-entry-bluepoint.png"), fullPage: true });

  // 切到「出蓝=是」→ 标签应变成「船型」
  await page.click('[data-act="form-blue"][data-value="1"]');
  await page.waitForTimeout(250);
  const labelAfter = (await page.locator('[data-role="type-label"]').innerText()).trim();
  check("需求2/4 出蓝=是 时字段叫「船型」", labelAfter === "船型", `实际="${labelAfter}"`);

  const subEnabled = await page.locator('[data-act="form-sub"][data-value="blueFont"]').isDisabled();
  check("出蓝=是 时子型号可选", subEnabled === false);

  await page.screenshot({ path: path.join(SHOTS, "4-entry-shiptype.png"), fullPage: true });

  // 保底箱子强制出蓝 → 标签应为船型
  await page.click('[data-act="form-box"][data-value="pity"]');
  await page.waitForTimeout(250);
  const labelPity = (await page.locator('[data-role="type-label"]').innerText()).trim();
  const pityDisabled = await page.locator('[data-act="form-blue"][data-value="0"]').isDisabled();
  check("保底箱子强制出蓝，标签为「船型」", labelPity === "船型" && pityDisabled, `label=${labelPity} 否禁用=${pityDisabled}`);

  /* ── 描述（1.1.0 取代了附件） ──────────────────────────────────────────── */
  const descField = page.locator("#f-desc");
  const descIsTextarea = await descField.evaluate((e) => e.tagName === "TEXTAREA");
  const attachLeft = await page
    .locator('[data-act="form-pick-att"], [data-act="form-remove-att"], .field:has-text("附件")')
    .count();
  check(
    "附件已换成描述输入框（多行文本框，没有残留的附件控件）",
    descIsTextarea && attachLeft === 0,
    `textarea=${descIsTextarea} 附件残留=${attachLeft}`
  );

  // 录一笔带描述的，验证能写进去
  await page.fill("#f-desc", "首充出的，跟车三连");
  const before = await page.locator(".nav-count").innerText();
  await page.click('button[type="submit"]');
  await page.waitForTimeout(600);
  const after = await page.locator(".nav-count").innerText();
  check("录入能写入记录", Number(after) === Number(before) + 1, `${before} → ${after}`);

  const savedDesc = await page.evaluate(() => {
    const arr = window.__mock.countOf("db-1");
    const all = window.__mock.allOf("db-1");
    return all[all.length - 1]?.description ?? null;
  });
  check("描述随记录一起存下来", savedDesc === "首充出的，跟车三连", `存到的是 ${JSON.stringify(savedDesc)}`);

  // 描述是「这一笔」的备注，提交后必须清空，否则会挂到下一笔上
  const descAfterSubmit = await page.locator("#f-desc").inputValue();
  check("提交后描述清空（不会粘到下一笔）", descAfterSubmit === "", `残留=${JSON.stringify(descAfterSubmit)}`);

  /* ── 录入页要能选「写进哪个库」 ─────────────────────────────────────────── */
  const entryBar = await page.locator(".db-bar").count();
  const entryExtraBtns = await page
    .locator('.db-bar [data-act="db-rename"], .db-bar [data-act="db-create-open"], .db-bar [data-act="db-manage"], .db-bar [data-act="tab"]')
    .count();
  check(
    "录入页只留下拉切换（不放重命名 / 新建 / 管理 / 新增记录）",
    entryBar === 1 && entryExtraBtns === 0,
    `栏=${entryBar} 多余按钮=${entryExtraBtns}`
  );

  await page.selectOption(".db-pick", "db-2");
  await page.waitForTimeout(700);
  const hintText = await page.locator(".entry-form .form-hint").last().innerText();
  check("录入页写明这一笔将记入哪个库", hintText.includes("小号试水"), hintText.replace(/\s+/g, " ").trim());

  // 表单里填的东西换库后不该被清掉 —— 换库是在挑「记到哪」，不是重填
  await page.click('[data-act="form-ship"][data-value="carrier"]');
  await page.waitForTimeout(250);
  await page.selectOption(".db-pick", "db-1");
  await page.waitForTimeout(700);
  const keptShip = await page
    .locator('[data-act="form-ship"][data-value="carrier"]')
    .evaluate((e) => e.classList.contains("is-active"));
  check("换库不会清掉已经填好的表单", keptShip, `航母仍选中=${keptShip}`);

  await page.selectOption(".db-pick", "db-2");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, "13-entry-dbbar.png"), fullPage: true });

  const beforeB = await page.evaluate(() => window.__mock.countOf("db-2"));
  const beforeA = await page.evaluate(() => window.__mock.countOf("db-1"));
  await page.click('.entry-form button[type="submit"]');
  await page.waitForTimeout(700);
  const afterB = await page.evaluate(() => window.__mock.countOf("db-2"));
  const afterA = await page.evaluate(() => window.__mock.countOf("db-1"));
  check(
    "录入真的写进所选的库，而不是上一个库",
    afterB === beforeB + 1 && afterA === beforeA,
    `db-2 ${beforeB}→${afterB}，db-1 ${beforeA}→${afterA}`
  );

  // 收回 db-1，后面的用例继续在原来的库上跑
  await page.selectOption(".db-pick", "db-1");
  await page.waitForTimeout(600);

  /* ── 记录 ─────────────────────────────────────────────────────────────── */
  await page.click('[data-act="tab"][data-tab="records"]');
  await page.waitForSelector(".record-row");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "5-records-list.png"), fullPage: true });

  const rows = await page.locator(".record-row").count();
  check("记录列表渲染", rows > 0, `行数=${rows}`);

  // 大船标签跟着「出蓝」变：出蓝=大船，没出蓝=大船点
  const tagPairs = await page.$$eval(".record-row", (rows) =>
    rows
      .filter((row) => row.querySelector(".tag"))
      .map((row) => ({
        tag: row.querySelector(".tag").textContent.trim(),
        isBlue: Boolean(row.querySelector(".cell-blue .blue-chip"))
      }))
  );
  const blueOnes = tagPairs.filter((p) => p.isBlue);
  const dotOnes = tagPairs.filter((p) => !p.isBlue);
  check(
    "记录里的大船标签：出蓝写「大船」、没出蓝写「大船点」",
    blueOnes.length > 0 &&
      dotOnes.length > 0 &&
      blueOnes.every((p) => p.tag === "大船") &&
      dotOnes.every((p) => p.tag === "大船点"),
    `带标签 ${tagPairs.length} 个：出蓝 ${blueOnes.length}（${[...new Set(blueOnes.map((p) => p.tag))].join("/") || "—"}）、没出蓝 ${dotOnes.length}（${[...new Set(dotOnes.map((p) => p.tag))].join("/") || "—"}）`
  );

  // 描述列：表头叫「描述」，有描述的显示得出来
  const descHead = await page.locator(".record-head span").nth(4).innerText();
  const descCells = await page.locator(".record-row .desc-text").count();
  check("记录列表有描述列", descHead.trim() === "描述" && descCells > 0, `表头=${descHead.trim()} 有描述的行=${descCells}`);

  // 编辑一行，验证内联编辑可用（描述是文本框，不是附件按钮）
  await page.locator('[data-act="edit"]').first().click();
  await page.waitForSelector(".record-row.is-editing");
  const editSels = await page.locator(".record-row.is-editing select").count();
  const editDesc = await page.locator('.record-row.is-editing [data-edit="description"]').count();
  check("内联编辑可用（两个下拉 + 描述输入框）", editSels === 2 && editDesc === 1, `select=${editSels} 描述框=${editDesc}`);

  // 改描述并保存
  const editRow = page.locator(".record-row.is-editing");
  const editedId = await editRow.getAttribute("data-edit-id");
  await page.fill('.record-row.is-editing [data-edit="description"]', "列表里改的描述");
  await page.locator('[data-act="edit-save"]').first().click();
  await page.waitForTimeout(700);
  const stored = await page.evaluate(
    (id) => (window.__mock.allOf(window.__mock.activeId()).find((r) => r.id === id) ?? {}).description,
    editedId
  );
  check("在列表里能把描述改掉并存住", stored === "列表里改的描述", `存到的是 ${JSON.stringify(stored)}`);

  await page.locator('[data-act="edit"]').first().click();
  await page.waitForSelector(".record-row.is-editing");
  await page.locator('[data-act="edit-cancel"]').first().click();
  await page.waitForTimeout(200);

  // 表格视图
  await page.click('[data-act="list-view"][data-value="grid"]');
  await page.waitForTimeout(300);
  const cells = await page.locator(".rec-cell").count();
  check("表格视图渲染", cells > 0, `格数=${cells}`);
  await page.screenshot({ path: path.join(SHOTS, "6-records-grid.png"), fullPage: true });
  await page.click('[data-act="list-view"][data-value="list"]');
  await page.waitForTimeout(200);

  /* ── 设置 / 需求 1 ────────────────────────────────────────────────────── */
  await page.click('[data-act="tab"][data-tab="settings"]');
  await page.waitForSelector(".db-row");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "7-settings-db.png"), fullPage: true });

  const dbRows = await page.locator(".db-row").count();
  check("需求1 数据库清单列出多个库", dbRows === 2, `行数=${dbRows}`);

  const activeRows = await page.locator(".db-row.is-active").count();
  check("需求1 标出正在使用的库", activeRows === 1);

  // 重命名显示名
  await page.locator('[data-act="db-rename"]').first().click();
  await page.waitForSelector(".db-rename-form input");
  await page.fill(".db-rename-form input", "重命名测试");
  await page.locator('.db-rename-form button[type="submit"]').click();
  await page.waitForTimeout(400);
  const renamed = await page.locator(".db-row-name").first().innerText();
  check("需求1 数据库可以重命名（显示名）", renamed.trim() === "重命名测试", `实际="${renamed.trim()}"`);

  // 改磁盘文件名
  await page.locator('[data-act="db-rename-file"]').first().click();
  await page.waitForSelector('[data-field="dbFileName"]');
  await page.fill('[data-field="dbFileName"]', "我的主库");
  await page.locator('.db-rename-form button[type="submit"]').click();
  await page.waitForTimeout(400);
  const newPath = await page.locator(".db-row-path").first().innerText();
  check("需求1 数据库可以改文件名（磁盘）", newPath.includes("我的主库.db"), newPath.trim());

  // 新建数据库
  await page.click('[data-act="db-create-open"]');
  await page.waitForSelector('[data-field="dbName"][data-focus-key="dbName-new"]');
  await page.fill('[data-field="dbName"]', "第三赛季");
  await page.locator('.db-create-form button[type="submit"]').click();
  await page.waitForTimeout(500);
  const dbRows3 = await page.locator(".db-row").count();
  check("需求1 可以新建更多数据库", dbRows3 === 3, `行数=${dbRows3}`);
  await page.screenshot({ path: path.join(SHOTS, "8-settings-db-multi.png"), fullPage: true });

  // 设置页整体居中
  const settingCentering = await page.evaluate(() => {
    const main = document.querySelector(".main").getBoundingClientRect();
    return [...document.querySelectorAll(".settings-block, .db-row")].map((el) => {
      const r = el.getBoundingClientRect();
      return Math.abs(r.left - main.left - (main.right - r.right));
    });
  });
  check("需求3 设置页居中", Math.max(...settingCentering) <= 2, `最大差 ${Math.max(...settingCentering).toFixed(1)}px`);

  /* ── 记录页也要能管数据库 ─────────────────────────────────────────────── */
  await page.click('[data-act="tab"][data-tab="records"]');
  await page.waitForSelector(".db-bar");
  await page.waitForTimeout(300);

  const pickOpts = await page.locator(".db-pick option").count();
  check("记录页有数据库切换器", pickOpts === 3, `选项=${pickOpts}`);

  // 换库：选第一个（国服主号）
  const beforePick = await page.evaluate(() => window.__mock.activeId());
  await page.selectOption(".db-pick", "db-1");
  await page.waitForTimeout(600);
  const afterPick = await page.evaluate(() => window.__mock.activeId());
  check("记录页可以直接切换数据库", beforePick !== afterPick && afterPick === "db-1", `${beforePick} → ${afterPick}`);

  // 重命名
  await page.click('[data-act="db-rename"]');
  await page.waitForSelector(".db-bar-form input");
  await page.fill(".db-bar-form input", "记录页改名");
  await page.locator('.db-bar-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  const barName = await page.locator(".db-pick option:checked").innerText();
  check("记录页可以重命名数据库", barName.includes("记录页改名"), barName.trim());

  // 新建
  await page.click('[data-act="db-create-open"]');
  await page.waitForSelector(".db-bar-form input");
  await page.fill(".db-bar-form input", "记录页新建");
  await page.locator('.db-bar-form button[type="submit"]').click();
  await page.waitForTimeout(700);
  const optsAfterCreate = await page.locator(".db-pick option").count();
  const newActive = await page.evaluate(() => window.__mock.activeId());
  check("记录页可以新建数据库并切过去", optsAfterCreate === 4 && newActive === "db-4", `选项=${optsAfterCreate} 当前=${newActive}`);

  // 新建出来的库是空的 —— 这正是原来会卡死的地方：记录页空空如也，
  // 界面上得留着切换器才回得去
  const emptyShown = await page.locator(".empty-title").count();
  const barStillThere = await page.locator(".db-bar").count();
  check("空数据库时记录页仍留着切换器", emptyShown === 1 && barStillThere === 1, `空状态=${emptyShown} 切换器=${barStillThere}`);

  // 换回有数据的库，确认能回去
  await page.selectOption(".db-pick", "db-1");
  await page.waitForTimeout(700);
  const backRows = await page.locator(".record-row").count();
  check("从空库能切回有数据的库", backRows > 0, `行数=${backRows}`);
  await page.screenshot({ path: path.join(SHOTS, "12-records-dbbar.png"), fullPage: true });

  /* ── 清空数据库（记录页，挨着「新增记录」） ───────────────────────────── */
  // 按钮要挨着「新增记录」：两个都在同一条栏里，且在元素序列上相邻
  const adjacent = await page.evaluate(() => {
    const kids = [...document.querySelector(".db-bar").children];
    return {
      iNew: kids.findIndex((e) => e.dataset.act === "tab" && e.dataset.tab === "entry"),
      iClear: kids.findIndex((e) => e.classList.contains("is-danger"))
    };
  });
  check(
    "记录页有「清空数据库」，且紧挨着「新增记录」",
    adjacent.iClear > -1 && Math.abs(adjacent.iNew - adjacent.iClear) === 1,
    `新增记录@${adjacent.iNew} 清空@${adjacent.iClear}`
  );

  // 拿 db-2 当靶子，别动 db-1（后面一堆用例还要用那份数据）
  await page.selectOption(".db-pick", "db-2");
  await page.waitForTimeout(700);
  const victimBefore = await page.evaluate(() => window.__mock.countOf("db-2"));
  const keeperBefore = await page.evaluate(() => window.__mock.countOf("db-1"));

  // 点一下不该直接清 —— 必须先出确认
  await page.click('[data-act="clear-ask"]');
  await page.waitForTimeout(350);
  const afterAsk = await page.evaluate(() => window.__mock.countOf("db-2"));
  const askText = await page.locator(".db-bar .confirm-text").innerText();
  check(
    "点「清空数据库」只出确认、不动数据",
    afterAsk === victimBefore && askText.includes(String(victimBefore)),
    `条数 ${victimBefore} → ${afterAsk}；确认文案：${askText.replace(/\s+/g, " ").trim()}`
  );
  await page.screenshot({ path: path.join(SHOTS, "14-records-clear-confirm.png"), fullPage: true });

  // 取消 → 数据还在，按钮复位
  await page.click('[data-act="clear-no"]');
  await page.waitForTimeout(350);
  const afterNo = await page.evaluate(() => window.__mock.countOf("db-2"));
  const backToButton = await page.locator('[data-act="clear-ask"]').count();
  check("点取消：数据还在、按钮复位", afterNo === victimBefore && backToButton === 1, `条数=${afterNo}`);

  // 切走再回来，待确认状态要收掉
  await page.click('[data-act="clear-ask"]');
  await page.waitForTimeout(300);
  await page.click('[data-act="tab"][data-tab="board"]');
  await page.waitForTimeout(500);
  await page.click('[data-act="tab"][data-tab="records"]');
  await page.waitForTimeout(700);
  const stillAsking = await page.locator(".db-bar .confirm-text").count();
  check("切走再回来，待确认清空会收掉", stillAsking === 0, `还在问=${stillAsking}`);

  // 真确认 → 清空当前库
  await page.click('[data-act="clear-ask"]');
  await page.waitForTimeout(300);
  await page.click('[data-act="clear-yes"]');
  await page.waitForTimeout(800);
  const cleared = await page.evaluate(() => window.__mock.countOf("db-2"));
  const keeperAfter = await page.evaluate(() => window.__mock.countOf("db-1"));
  const emptyNow = await page.locator(".empty-title").count();
  check(
    "确认后清空的是当前库，别的库一条没少",
    cleared === 0 && keeperAfter === keeperBefore && emptyNow === 1,
    `db-2 ${victimBefore}→${cleared}，db-1 保持 ${keeperAfter}`
  );

  // 回到 db-1，后面的用例继续用那份数据
  await page.selectOption(".db-pick", "db-1");
  await page.waitForTimeout(700);
  const restored = await page.locator(".record-row").count();
  check("切回 db-1：数据完好", restored === keeperBefore, `行数=${restored}，应为 ${keeperBefore}`);

  /* ── 库打不开时，设置页仍然进得去 ─────────────────────────────────────── */
  await page.evaluate(() => window.__mock.setConnected(false));
  await page.click('[data-act="tab"][data-tab="board"]');
  await page.waitForTimeout(400);
  const offlineHasSettings = await page.locator('[data-act="tab"][data-tab="settings"]').count();
  await page.click('[data-act="tab"][data-tab="settings"]');
  await page.waitForTimeout(400);
  const offlineDbRows = await page.locator(".db-row").count();
  const offlineError = await page.locator(".db-error").count();
  // 「去设置」按钮和侧栏导航项都带 data-tab="settings"，所以这里只要求 >= 1。
  // 库行数不写死 —— 前面几个用例会新建库，写死就会跟着一起碎。
  check(
    "库打不开时设置页仍可达（能去换库 / 改位置）",
    offlineHasSettings >= 1 && offlineDbRows >= 2 && offlineError === 1,
    `入口=${offlineHasSettings} 库行=${offlineDbRows} 错误提示=${offlineError}`
  );

  // 主题按钮在库没打开时也不能变哑巴
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('[data-act="theme"]');
  await page.waitForTimeout(400);
  const offlineTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const offlineToast = await page.locator(".toast.is-err").count();
  check(
    "库没打开时切主题：界面照切、并提示没存住",
    offlineTheme !== themeBefore && offlineToast >= 1,
    `${themeBefore} → ${offlineTheme}，toast=${offlineToast}`
  );

  await page.screenshot({ path: path.join(SHOTS, "10-settings-offline.png"), fullPage: true });
  await page.evaluate(() => window.__mock.setConnected(true));

  // 环境变量接管时，改文件名 / 改位置要禁用并说明
  await page.evaluate(() => window.__mock.setEnvOverride("D:\\portable\\openbox.db"));
  await page.click('[data-act="tab"][data-tab="entry"]');
  await page.waitForTimeout(200);
  await page.click('[data-act="tab"][data-tab="settings"]');
  await page.waitForTimeout(400);
  const envBanner = await page.locator(".db-env-note").count();
  const envDisabled = await page.locator('[data-act="db-rename-file"][disabled]').count();
  const envRows = await page.locator(".db-row").count();
  check(
    "环境变量接管时如实说明并禁用改名",
    envBanner === 1 && envDisabled === envRows,
    `横幅=${envBanner} 禁用=${envDisabled}/${envRows} 行`
  );
  await page.screenshot({ path: path.join(SHOTS, "11-settings-env.png"), fullPage: true });
  await page.evaluate(() => window.__mock.setEnvOverride(""));

  /* ── 浅色主题兜底 ─────────────────────────────────────────────────────── */
  const themeBeforeLight = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('[data-act="theme"]');
  await page.waitForTimeout(400);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  check("主题可来回切换", theme !== themeBeforeLight, `${themeBeforeLight} → ${theme}`);

  // 确保停在浅色再截图，好把浅色下的对比度看一遍
  if (theme !== "light") {
    await page.click('[data-act="theme"]');
    await page.waitForTimeout(400);
  }
  await page.click('[data-act="tab"][data-tab="board"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, "9-board-light.png"), fullPage: true });
  const themeNow = await page.evaluate(() => document.documentElement.dataset.theme);
  check("浅色主题渲染正常", themeNow === "light", `theme=${themeNow}`);

  /* ── 控制台干净 ───────────────────────────────────────────────────────── */
  check("无 JS 报错", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  console.log(`截图目录：${SHOTS}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error("验证脚本自身出错：", err);
  process.exit(2);
});

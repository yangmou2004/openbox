/**
 * 主进程集成测试。
 *
 * 把 out/main/index.js 用替身 electron 跑起来，然后直接调它注册的 IPC 处理器 ——
 * 走的完全是真实代码路径（真 SQLite、真文件、真清单），只是没有窗口。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "..");
// 默认测源码目录；设了 OB_APP_DIR 就测那个（用来验证打包出来的 app.asar 解包后能不能跑）
const SRC = process.env.OB_APP_DIR || path.join(ROOT, "_app_src");
const TMP = path.join(os.tmpdir(), process.env.OB_TMP || "ob-main-test");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
}

/* ── 搭一个可运行的 app 副本 ─────────────────────────────────────────────── */
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const APP = path.join(TMP, "app");
fs.cpSync(SRC, APP, { recursive: true });

const NM = path.join(APP, "node_modules", "electron");
fs.mkdirSync(NM, { recursive: true });
fs.copyFileSync(path.join(__dirname, "stub", "electron-stub.js"), path.join(NM, "index.js"));
fs.writeFileSync(
  path.join(NM, "package.json"),
  JSON.stringify({ name: "electron", version: "0.0.0", main: "index.js" })
);

const STUB_PATH = path.join(NM, "index.js");

/*
 * 替身模块也在 APP 目录下，所以「清缓存重载」会连它一起清掉 ——
 * 重载之后拿到的是**另一个**实例，它的 handlers 是空的新 Map。
 * 因此 handlers/hooks 必须每次都从当前实例重新取，不能开头存一份就完事。
 */
let handlers = new Map();
let hooks = {};

const call = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel}`);
  return fn({}, ...args);
};

async function loadApp(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  // 清掉上一次的模块缓存，模拟「重新启动应用」
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(APP)) delete require.cache[k];
  }
  process.env.OPENBOX_DATA_DIR = dataDir;

  require(STUB_PATH);
  require(path.join(APP, "out", "main", "index.js"));

  // 等 whenReady().then(...) 把 IPC 注册完，然后取当前实例的 handlers
  for (let i = 0; i < 100; i++) {
    const stub = require(STUB_PATH);
    if (stub.__handlers.has("db:list")) {
      handlers = stub.__handlers;
      hooks = stub.__hooks;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("主进程没能在 2.5s 内注册 IPC");
}

const rec = (over = {}) => ({
  openedAt: new Date().toISOString(),
  boxType: "coin",
  shipType: "frigate",
  isBlue: false,
  blueFont: false,
  blueNewImage: false,
  ...over
});

(async () => {
  /* ══ A. 多数据库 ═══════════════════════════════════════════════════════ */
  const DATA = path.join(TMP, "data");
  await loadApp(DATA);

  const registryPath = path.join(DATA, "databases.json");
  check("首次启动生成 databases.json", fs.existsSync(registryPath));

  let list = await call("db:list");
  check(
    "需求1 首次启动只有一个库，名为「默认数据库」",
    list.items.length === 1 && list.items[0].name === "默认数据库" && list.items[0].active,
    `${list.items.length} 个 / ${list.items[0]?.name}`
  );

  // 1 号库写 12 条
  const db1 = list.items[0].id;
  for (let i = 0; i < 12; i++) {
    await call("records:add", rec({ shipType: i % 2 ? "fighter" : "cruiser", isBlue: i % 3 === 0 }));
  }
  let rows = await call("records:list");
  check("默认库写入 12 条记录", rows.length === 12, `实际 ${rows.length}`);

  // 保底箱子强制出蓝
  const pity = await call("records:add", rec({ boxType: "pity", isBlue: false }));
  check("保底箱子强制记为出蓝", pity.isBlue === true);

  // 新建第二个库
  list = await call("db:create", "第二赛季");
  check("需求1 可以新建数据库", list.items.length === 2, `${list.items.length} 个`);
  const db2 = list.createdId;
  check("需求1 新建后自动切过去", list.activeId === db2 && list.items.find((i) => i.id === db2).active);

  rows = await call("records:list");
  check("新库是空的（与旧库互不干扰）", rows.length === 0, `实际 ${rows.length}`);

  for (let i = 0; i < 5; i++) await call("records:add", rec({ shipType: "carrier", isBlue: true }));

  list = await call("db:list");
  const i1 = list.items.find((i) => i.id === db1);
  const i2 = list.items.find((i) => i.id === db2);
  check("需求1 清单里各自显示记录条数", i1.recordCount === 13 && i2.recordCount === 5, `${i1.recordCount} / ${i2.recordCount}`);

  // 设置也跟着库走
  await call("settings:save", { theme: "light" });
  check("设置写入当前库", (await call("settings:get")).theme === "light");

  // 切回 1 号库
  list = await call("db:switch", db1);
  check("需求1 可以切换数据库", list.activeId === db1);
  rows = await call("records:list");
  check("切回去数据还在", rows.length === 13, `实际 ${rows.length}`);
  check("各库设置互相独立", (await call("settings:get")).theme === "dark", (await call("settings:get")).theme);

  /* ── 重命名显示名 ── */
  list = await call("db:rename", db2, "  赛季二  ");
  const renamed = list.items.find((i) => i.id === db2);
  check("需求1 数据库可以重命名（显示名）", renamed.name === "赛季二", `实际「${renamed.name}」`);

  /* ── 改磁盘文件名 ── */
  const oldFile = renamed.file;
  list = await call("db:renameFile", db2, "season-2");
  const afterRename = list.items.find((i) => i.id === db2);
  check(
    "需求1 可以改磁盘文件名",
    afterRename.file.endsWith("season-2.db") && !fs.existsSync(oldFile) && fs.existsSync(afterRename.file),
    afterRename.file.replace(DATA, "…")
  );

  // 文件名非法字符要被清掉、.db 后缀不重复
  list = await call("db:renameFile", db2, "a/b:c*d?.db");
  check(
    "改文件名会清掉非法字符",
    list.items.find((i) => i.id === db2).file.endsWith("abcd.db"),
    list.items.find((i) => i.id === db2).file.replace(DATA, "…")
  );

  // 重名要真的撞上：先把 2 号改叫 shared，再让 1 号也叫 shared
  await call("db:renameFile", db2, "shared");
  let dupErr = null;
  try {
    await call("db:renameFile", db1, "shared");
  } catch (e) {
    dupErr = e.message;
  }
  check("改成一个已存在的文件名会被拒绝", Boolean(dupErr) && /已经存在/.test(dupErr), dupErr ?? "（竟然没报错）");
  // 回归：被拒的那一次不能把连接赔进去（1 号此刻是在用的那个库）
  rows = await call("records:list");
  check("被拒的改名不会把连接弄断", rows.length === 13, `实际 ${rows.length}`);

  // 对「正在使用」的库改文件名，要能改名并自动重连
  await call("db:switch", db2);
  list = await call("db:renameFile", db2, "main-season");
  rows = await call("records:list");
  check("对正在使用的库改名后自动重连、数据还在", rows.length === 5, `实际 ${rows.length}`);

  /* ── 移除 ── */
  const keepFile = list.items.find((i) => i.id === db2).file;
  list = await call("db:remove", db2);
  check("需求1 可以从清单移除数据库", list.items.length === 1, `${list.items.length} 个`);
  check("移除不动磁盘文件", fs.existsSync(keepFile));

  let lastErr = null;
  try {
    await call("db:remove", db1);
  } catch (e) {
    lastErr = e.message;
  }
  check("最后一个库不允许移除", Boolean(lastErr), lastErr ?? "");
  // 回归：上面那次失败的移除会把 1 号关掉又没重连，导出就会报「数据库未打开」
  rows = await call("records:list");
  check("被拒的移除不会把连接弄断", rows.length === 13, `实际 ${rows.length}`);

  /* ── 导出 / 导入 ── */
  const expPath = path.join(TMP, "export.json");
  hooks.saveDialog = async () => ({ canceled: false, filePath: expPath });
  const exp = await call("data:export");
  const exported = JSON.parse(fs.readFileSync(expPath, "utf-8"));
  check("导出 JSON 带数据库名与记录", exp.ok && exported.databaseName === "默认数据库" && exported.records.length === 13, `${exported.records?.length} 条`);

  hooks.openDialog = async () => ({ canceled: false, filePaths: [expPath] });
  const imp = await call("data:import");
  check("重复导入按 ID 去重", imp.ok && imp.added === 0 && imp.skipped === 13, `新增 ${imp.added} / 跳过 ${imp.skipped}`);

  /* ── 记录增删改 ── */
  const added = await call("records:add", rec({ shipType: "battlecruiser", isBlue: true, blueFont: true }));
  const updated = await call("records:update", added.id, { shipType: "destroyer", isBlue: false, blueFont: true });
  check("更新记录时会清掉不再适用的出蓝子项", updated.shipType === "destroyer" && updated.blueFont === false);

  /* ── 描述（1.1.0 取代了附件） ─────────────────────────────────────────── */
  const withDesc = await call("records:add", rec({ description: "  首充出的  " }));
  check("描述写入时去空白", withDesc.description === "首充出的", JSON.stringify(withDesc.description));

  const cleared = await call("records:update", withDesc.id, { description: "   " });
  check("把描述清成空白等于删掉它", cleared.description === undefined, JSON.stringify(cleared.description));

  const longDesc = await call("records:add", rec({ description: "字".repeat(900) }));
  check("超长描述被截到 500 字", longDesc.description.length === 500, `实长 ${longDesc.description.length}`);

  const noDesc = await call("records:add", rec({}));
  check("没写描述就不带这个键", !("description" in noDesc), JSON.stringify(noDesc.description));

  // 导出里带描述、且不再有 attachment。
  // 专门为这一步新加一条 —— 上面那几条到这儿已经被改过或删过，拿它们断言是在考自己。
  const expRec = await call("records:add", rec({ description: "导出要带上的描述" }));
  const exp2 = path.join(TMP, "export-desc.json");
  hooks.saveDialog = async () => ({ canceled: false, filePath: exp2 });
  await call("data:export");
  const expJson = JSON.parse(fs.readFileSync(exp2, "utf-8"));
  const expRow = expJson.records.find((r) => r.id === expRec.id);
  check(
    "导出：版本号 5、有 description、没有 attachment",
    expJson.version === 5 && expRow?.description === "导出要带上的描述" && !("attachment" in (expRow ?? {})),
    `version=${expJson.version} description=${JSON.stringify(expRow?.description)} attachment=${"attachment" in (expRow ?? {})}`
  );

  // 老文件里的 attachment 字段应当被忽略，不能当描述塞进来
  const legacyExport = path.join(TMP, "export-legacy.json");
  fs.writeFileSync(
    legacyExport,
    JSON.stringify({
      version: 4,
      records: [
        {
          id: "legacy-att-1",
          openedAt: new Date().toISOString(),
          boxType: "coin",
          shipType: "fighter",
          isBlue: false,
          attachment: "att-123.png"
        }
      ]
    })
  );
  hooks.openDialog = async () => ({ canceled: false, filePaths: [legacyExport] });
  await call("data:import");
  const importedLegacy = (await call("records:list")).find((r) => r.id === "legacy-att-1");
  check(
    "导入 1.0.0 的老文件：attachment 被忽略，不会当成描述",
    importedLegacy && importedLegacy.description === undefined,
    JSON.stringify(importedLegacy?.description)
  );

  await call("records:delete", withDesc.id);
  await call("records:delete", longDesc.id);
  await call("records:delete", noDesc.id);
  await call("records:delete", expRec.id);
  await call("records:delete", "legacy-att-1");

  await call("records:delete", added.id);
  rows = await call("records:list");
  check("删除记录生效", rows.length === 13, `实际 ${rows.length}`);

  check("删除会留下审计日志", fs.existsSync(path.join(DATA, "delete-audit.log")));

  /* ── 坏数据被挡在写入之前 ── */
  let badErr = null;
  try {
    await call("records:add", rec({ shipType: "dreadnought" }));
  } catch (e) {
    badErr = e.message;
  }
  check("非法船型写入被拒绝", Boolean(badErr), badErr ?? "");

  /* ══ B. 从 1.0.0 的单库配置升级 ══════════════════════════════════════ */
  const DATA2 = path.join(TMP, "data-legacy");
  const legacyFile = path.join(TMP, "legacy", "old.db");
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.mkdirSync(DATA2, { recursive: true });
  fs.writeFileSync(path.join(DATA2, "db.config.json"), JSON.stringify({ file: legacyFile }), "utf-8");

  await loadApp(DATA2);
  const legacyList = await call("db:list");
  check(
    "升级：读得懂 1.0.0 的 db.config.json",
    legacyList.items.length === 1 && legacyList.items[0].file === legacyFile,
    legacyList.items[0]?.file
  );
  check("升级后旧文件照常建表可用", fs.existsSync(legacyFile));
  const legacyRows = await call("records:list");
  check("升级后的库可以直接读写", Array.isArray(legacyRows));

  /* ══ C. 从 1.0.0 的老库结构升级（attachment → description） ═══════════ */
  const DATA3 = path.join(TMP, "data-oldschema");
  const oldDb = path.join(TMP, "oldschema", "old.db");
  fs.mkdirSync(path.dirname(oldDb), { recursive: true });
  fs.mkdirSync(DATA3, { recursive: true });

  // 照 1.0.0 的建表语句造一个库，并塞一条带附件的记录
  {
    const { DatabaseSync } = require("node:sqlite");
    const h = new DatabaseSync(oldDb);
    h.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id             TEXT    NOT NULL PRIMARY KEY,
        opened_at      TEXT    NOT NULL,
        box_type       TEXT    NOT NULL,
        ship_type      TEXT    NOT NULL,
        is_blue        INTEGER NOT NULL DEFAULT 0,
        blue_font      INTEGER NOT NULL DEFAULT 0,
        blue_new_image INTEGER NOT NULL DEFAULT 0,
        attachment     TEXT    NULL,
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id         INTEGER NOT NULL PRIMARY KEY,
        data       TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
    `);
    const at = "2026-01-02 03:04:05";
    h.prepare(
      "INSERT INTO records (id, opened_at, box_type, ship_type, is_blue, blue_font, blue_new_image, attachment, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run("old-1", at, "coin", "cruiser", 1, 0, 1, "att-999.png", at, at);
    h.close();
  }

  fs.writeFileSync(path.join(DATA3, "db.config.json"), JSON.stringify({ file: oldDb }), "utf-8");
  await loadApp(DATA3);

  const cols = (() => {
    const { DatabaseSync } = require("node:sqlite");
    const h = new DatabaseSync(oldDb);
    const names = h.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
    h.close();
    return names;
  })();
  check("老库被自动补上 description 列", cols.includes("description"), cols.join(", "));
  check("老库的 attachment 列原样留着（不删列）", cols.includes("attachment"));

  const oldRows = await call("records:list");
  check("老库里的记录照常读得出来", oldRows.length === 1 && oldRows[0].shipType === "cruiser", `${oldRows.length} 条`);
  check(
    "老记录里那个附件文件名不会被当成描述",
    oldRows[0].description === undefined,
    JSON.stringify(oldRows[0].description)
  );

  const newInOld = await call("records:add", rec({ description: "迁移之后新写的" }));
  const reread = (await call("records:list")).find((r) => r.id === newInOld.id);
  check("老库迁移后能写描述并读回来", reread?.description === "迁移之后新写的", JSON.stringify(reread?.description));

  /* ── 收尾 ── */
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log("  - " + f.name));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("测试脚本自身出错：", e);
  process.exit(2);
});

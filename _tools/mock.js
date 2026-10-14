/**
 * 测试替身：把预加载脚本暴露的 window.openbox 换成一份内存实现，
 * 这样渲染层就能在普通 Chromium 里跑起来（Playwright 截图 / 断言用）。
 * 只用于验证界面，不进打包产物。
 *
 * 每个数据库各有一个独立的数据桶 —— 这一点必须和主进程一致，否则「新建一个库
 * 之后记录页是空的、得能切回去」这类问题在测试里根本暴露不出来。
 */
(function () {
  "use strict";

  const SHIPS = ["fighter", "frigate", "escort", "destroyer", "cruiser", "battlecruiser", "carrier", "support"];
  const BOXES = ["coin", "normal", "pangu", "pity"];

  // 固定种子，保证每次跑出来的数据一样
  let seed = 20261013;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const pick = (arr, weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  };

  const makeRecords = (n, idPrefix) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const daysAgo = Math.floor(rnd() * 80);
      const d = new Date(Date.now() - daysAgo * 86400000 - Math.floor(rnd() * 86400000));
      const boxType = pick(BOXES, [40, 35, 15, 10]);
      const shipType = pick(SHIPS, [26, 22, 16, 13, 9, 6, 4, 4]);
      const isBlue = boxType === "pity" ? true : rnd() < (boxType === "pangu" ? 0.34 : 0.12);
      const SAMPLE_DESCS = [
        "首充出的",
        "跟车三连",
        "活动最后一天补的",
        "手滑点错箱子了",
        "攒了一周的币一次开完",
        ""
      ];
      out.push({
        id: `${idPrefix}-${i}`,
        openedAt: d.toISOString(),
        boxType,
        shipType,
        isBlue,
        blueFont: isBlue && rnd() < 0.4,
        blueNewImage: isBlue && rnd() < 0.35,
        ...(rnd() < 0.3 ? { description: SAMPLE_DESCS[Math.floor(rnd() * SAMPLE_DESCS.length)] } : {}),
        createdAt: d.toISOString(),
        updatedAt: d.toISOString()
      });
    }
    return out;
  };

  let settings = { theme: "dark", rareTierThreshold: 5 };

  const DIR = "C:\\Users\\yangjia\\AppData\\Roaming\\openbox-tracker";

  let dbItems = [
    { id: "db-1", name: "国服主号", file: `${DIR}\\openbox.db`, isDefault: true },
    { id: "db-2", name: "小号试水", file: `${DIR}\\openbox-2.db`, isDefault: false }
  ];

  // 每个库一个数据桶
  const buckets = new Map();
  buckets.set("db-1", makeRecords(140, "a"));
  buckets.set("db-2", makeRecords(23, "b"));

  let activeId = "db-1";

  // 给测试用的开关：模拟「库打不开」和「环境变量接管」
  let connected = true;
  let envOverride = "";
  let fileExists = true;

  const bucket = () => buckets.get(activeId) ?? [];
  const byId = (id) => dbItems.find((d) => d.id === id);

  const listPayload = () => ({
    activeId,
    envOverride,
    items: dbItems.map((d) => ({
      ...d,
      active: d.id === activeId,
      exists: fileExists,
      size: (buckets.get(d.id) ?? []).length * 120 + 4096,
      recordCount: (buckets.get(d.id) ?? []).length
    }))
  });

  const status = () => {
    const active = byId(activeId) ?? dbItems[0];
    return {
      connected,
      error: connected
        ? null
        : "打不开数据库文件「C:\\x\\openbox.db」。请确认路径存在，且当前用户有写入权限。",
      file: active.file,
      dir: active.file.replace(/[\\/][^\\/]+$/, ""),
      exists: fileExists,
      size: bucket().length * 120 + 4096,
      customized: !active.isDefault,
      recordCount: bucket().length,
      name: active.name,
      activeId,
      envOverride
    };
  };

  window.openbox = {
    listRecords: async () => {
      if (!connected) throw new Error("records:list：数据库未打开，请检查数据库文件的位置");
      return bucket().map((r) => ({ ...r }));
    },
    addRecord: async (input) => {
      if (!connected) throw new Error("records:add：数据库未打开，请检查数据库文件的位置");
      const now = new Date().toISOString();
      const rec = {
        id: `new-${Date.now()}-${bucket().length}`,
        openedAt: input.openedAt ?? now,
        boxType: input.boxType,
        shipType: input.shipType,
        isBlue: input.boxType === "pity" ? true : Boolean(input.isBlue),
        blueFont: Boolean(input.blueFont) && (input.isBlue || input.boxType === "pity"),
        blueNewImage: Boolean(input.blueNewImage) && (input.isBlue || input.boxType === "pity"),
        createdAt: now,
        updatedAt: now
      };
      if (input.description) rec.description = input.description;
      bucket().push(rec);
      return { ...rec };
    },
    addRecords: async (inputs) => inputs.map((i) => i),
    updateRecord: async (id, patch) => {
      const arr = bucket();
      const i = arr.findIndex((r) => r.id === id);
      if (i < 0) return null;
      arr[i] = { ...arr[i], ...patch };
      return { ...arr[i] };
    },
    deleteRecord: async (id) => {
      const arr = bucket();
      const i = arr.findIndex((r) => r.id === id);
      if (i >= 0) arr.splice(i, 1);
      return i >= 0;
    },
    deleteRecords: async (ids) => ids.length,

    getSettings: async () => ({ ...settings }),
    saveSettings: async (patch) => {
      // 设置存在库里，库没打开就存不进去 —— 和主进程 requireConnected() 一致
      if (!connected) throw new Error("settings:save：数据库未打开，请检查数据库文件的位置");
      settings = { ...settings, ...patch };
      return { ...settings };
    },

    exportData: async () => ({ ok: true, path: "x.json", count: bucket().length }),
    importData: async () => ({ ok: true, added: 0, skipped: 0 }),

    dbStatus: async () => status(),
    dbList: async () => listPayload(),
    dbCreate: async (name) => {
      const n = dbItems.length + 1;
      const id = `db-${n}`;
      dbItems.push({
        id,
        name: (name || "").trim() || `数据库 ${n}`,
        file: `${DIR}\\openbox-${n}.db`,
        isDefault: false
      });
      buckets.set(id, []);
      activeId = id;
      return listPayload();
    },
    dbSwitch: async (id) => {
      if (!byId(id)) throw new Error("数据库不存在，可能已被移除");
      activeId = id;
      return listPayload();
    },
    dbRename: async (id, name) => {
      const d = byId(id);
      if (!d) throw new Error("数据库不存在，可能已被移除");
      d.name = (name || "").trim() || d.name;
      return listPayload();
    },
    dbRenameFile: async (id, base) => {
      const d = byId(id);
      if (!d) throw new Error("数据库不存在，可能已被移除");
      const dir = d.file.replace(/[\\/][^\\/]+$/, "");
      d.file = `${dir}\\${String(base).trim()}.db`;
      d.isDefault = false;
      return listPayload();
    },
    dbRemove: async (id) => {
      if (!byId(id)) throw new Error("数据库不存在，可能已被移除");
      if (dbItems.length <= 1) throw new Error("至少要保留一个数据库。可以先把这一个清空，但不能没有。");
      dbItems = dbItems.filter((d) => d.id !== id);
      buckets.delete(id);
      if (activeId === id) activeId = dbItems[0].id;
      return listPayload();
    },
    dbChooseFile: async () => ({ ok: false, canceled: true }),
    dbSave: async () => ({ ...status(), ok: true }),
    dbReset: async () => ({ ...status(), ok: true }),
    dbReconnect: async () => ({ ...status(), ok: true }),
    dbReveal: async () => ({ ok: true }),
    dbClear: async () => {
      const n = bucket().length;
      buckets.set(activeId, []);
      return { removed: n };
    },

    // 附件那三个 API 在 1.1.0 撤掉了，渲染层也不该再调它们 —— 这里干脆不提供，
    // 万一还有哪条路径在调，会当场报错而不是静默失败
  };

  window.__mock = {
    setConnected(v) {
      connected = v;
    },
    setEnvOverride(v) {
      envOverride = v;
    },
    setFileExists(v) {
      fileExists = v;
    },
    countOf: (id) => (buckets.get(id) ?? []).length,
    allOf: (id) => (buckets.get(id) ?? []).map((r) => ({ ...r })),
    activeId: () => activeId
  };
})();

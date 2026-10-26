// DOI 取件器 · 面板
// 读取当前论文页 → 选好保存文件夹 → 交给离屏文档下载（关掉面板也会继续）。

const DEFAULT_ROOT = "DOI取件";
const DB_NAME = "doifetch";
const STORE = "kv";

const state = {
  info: null,
  dirHandle: null,
  root: DEFAULT_ROOT,
  tasks: [],
  running: false,
};

const el = {
  title: document.getElementById("title"),
  doi: document.getElementById("doi"),
  chips: document.getElementById("chips"),
  banner: document.getElementById("banner"),
  folder: document.getElementById("folder"),
  pick: document.getElementById("pick"),
  start: document.getElementById("start"),
  list: document.getElementById("list"),
  tip: document.getElementById("tip"),
  zotero: document.getElementById("zotero"),
  zrow: document.getElementById("zrow"),
  zlabel: document.getElementById("zlabel"),
  zstate: document.getElementById("zstate"),
  ztarget: document.getElementById("ztarget"),
  batchBox: document.getElementById("batchBox"),
  batchText: document.getElementById("batchText"),
  batchCount: document.getElementById("batchCount"),
  batchStart: document.getElementById("batchStart"),
  batchHint: document.getElementById("batchHint"),
  batchList: document.getElementById("batchList"),
  wvpnBase: document.getElementById("wvpnBase"),
  diagBtn: document.getElementById("diagBtn"),
  diagOut: document.getElementById("diagOut"),
};

/* 注入页面：只读取，不修改（必须自包含，不能引用本文件的其它变量） */
function sniffForDiag() {
  const meta = document.querySelector('meta[name="citation_pdf_url"]');
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const pdf = anchors
    .map((anchor) => anchor.href)
    .filter((href) => /\/pdfft|\.pdf(\?|$)|\/pdf(\?|$)/i.test(href));
  const siPattern = /supplement|supporting|moesm|_esm|_si_|appendix|additional-file|补充|附加/i;
  const si = anchors
    .filter((anchor) => siPattern.test(anchor.href) || siPattern.test(anchor.textContent || ""))
    .map((anchor) => anchor.href);
  return {
    url: location.href,
    title: document.title,
    meta: meta ? meta.content : "",
    pdf: Array.from(new Set(pdf)).slice(0, 5),
    si: Array.from(new Set(si)).slice(0, 6),
  };
}

async function diagnoseCurrentPage() {
  el.diagBtn.disabled = true;
  el.diagOut.hidden = false;
  el.diagOut.value = "检测中…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("没有活动标签页");

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: sniffForDiag,
    });
    const info = (injected && injected.result) || {};
    const base = (el.wvpnBase.value || "").trim().replace(/\/+$/, "");
    const urls = [info.meta, ...(info.pdf || [])].filter(Boolean);

    const lines = [
      "标题: " + String(info.title || "").slice(0, 60),
      "地址: " + String(info.url || "").slice(0, 100),
      "citation_pdf_url: " + String(info.meta || "（无）").slice(0, 90),
      "PDF 链接: " + (info.pdf || []).length + " 个 | 补充材料: " + (info.si || []).length + " 个",
      "",
    ];

    if (urls.length) {
      const reply = await chrome.runtime.sendMessage({
        type: "diagnose",
        urls,
        base,
        tabId: tab.id,
      });
      for (const row of (reply && reply.rows) || []) {
        lines.push("[" + row.kind + "] " + (row.contentType || ""));
        if (row.reason) lines.push("  " + row.reason);
        lines.push("  " + row.url);
      }
    } else {
      lines.push("页面里没找到 PDF 链接 —— 可能是验证页，或论文页还没加载完。");
    }

    el.diagOut.value = lines.join("\n");
  } catch (err) {
    el.diagOut.value = "诊断失败: " + (err && err.message);
  } finally {
    el.diagBtn.disabled = false;
  }
}

/* ------------------------------------------------------------ 批量取件 */

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>,;]+/gi;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

function parseDois(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(DOI_RE)) {
    const doi = match[0].replace(/[.,;)\]}>'"]+$/, "");
    if (!doi || CJK_RE.test(doi)) continue;
    const key = doi.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(doi);
  }
  return found;
}

const BATCH_LABEL = {
  pending: "待处理",
  working: "取件中",
  challenge: "需人工验证",
  downloaded: "已下载",
  manual: "待手动",
  failed: "失败",
};

const BATCH_CLASS = {
  downloaded: "ok",
  failed: "bad",
  challenge: "warn",
  manual: "warn",
};

function renderBatch(state) {
  if (!el.batchList) return;
  el.batchList.innerHTML = "";
  if (!state || !(state.items || []).length) {
    if (el.batchCount) el.batchCount.textContent = "";
    return;
  }
  const done = state.items.filter((item) => item.status === "downloaded").length;
  if (el.batchCount) {
    el.batchCount.textContent = state.running
      ? ` ${state.current + 1}/${state.items.length}`
      : ` ${done}/${state.items.length} 完成`;
  }
  for (const item of state.items) {
    const row = document.createElement("li");
    const doi = document.createElement("span");
    doi.className = "bdoi";
    doi.textContent = item.doi;
    doi.title = item.detail || item.doi;

    const status = document.createElement("span");
    status.className = "bst " + (BATCH_CLASS[item.status] || "");
    status.textContent = BATCH_LABEL[item.status] || item.status;

    row.append(doi, status);
    el.batchList.appendChild(row);
  }
}

async function refreshBatch() {
  let state = null;
  try {
    state = await chrome.runtime.sendMessage({ type: "batch-state" });
  } catch (err) {
    state = null;
  }
  renderBatch(state);
  if (el.batchBox && state && (state.running || (state.items || []).length)) {
    el.batchBox.open = true;
  }
}

async function startBatch() {
  const dois = parseDois(el.batchText.value);
  const base = (el.wvpnBase.value || "").trim().replace(/\/+$/, "");

  if (!dois.length) {
    el.batchHint.className = "bhint warn";
    el.batchHint.textContent = "没识别到 DOI";
    return;
  }
  if (base && !/^https?:\/\//i.test(base)) {
    el.batchHint.className = "bhint warn";
    el.batchHint.textContent = "网关地址要以 https:// 开头";
    return;
  }

  await chrome.storage.local.set({ wvpnBase: base });
  el.batchHint.className = "bhint";
  el.batchHint.textContent = `开始处理 ${dois.length} 篇…（可以关掉面板，后台会继续）`;
  el.batchStart.disabled = true;

  try {
    const reply = await chrome.runtime.sendMessage({ type: "batch-run", dois, base });
    if (reply && reply.ok) renderBatch(reply.state);
    else el.batchHint.textContent = "启动失败：" + ((reply && reply.error) || "未知原因");
  } catch (err) {
    el.batchHint.className = "bhint warn";
    el.batchHint.textContent = "启动失败：" + (err && err.message);
  } finally {
    el.batchStart.disabled = false;
  }
}

async function loadZoteroTargets() {
  let info = { ok: false, targets: [] };
  try {
    info = (await chrome.runtime.sendMessage({ type: "zotero-collections" })) || info;
  } catch (err) {
    info = { ok: false, targets: [] };
  }

  if (!info.ok || !(info.targets || []).length) {
    el.ztarget.hidden = true;
    return;
  }

  const previous = el.ztarget.value;
  el.ztarget.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent =
    "跟随 Zotero 当前选中" + (info.current && info.current.name ? "（" + info.current.name + "）" : "");
  el.ztarget.appendChild(auto);

  for (const target of info.targets) {
    const option = document.createElement("option");
    option.value = target.id;
    // 用全角空格做层级缩进，和 Zotero 里的树保持一致
    option.textContent = "　".repeat(Math.max(0, target.level || 0)) + target.name;
    el.ztarget.appendChild(option);
  }

  el.ztarget.value = previous || "";
  el.ztarget.hidden = false;
}

function renderZotero(z) {
  if (!z) return;
  el.zstate.className = "zstate";
  if (z.state === "running") {
    el.zstate.textContent = "存入中…";
  } else if (z.state === "ok") {
    el.zstate.textContent = "✓ " + z.added + " 个附件";
    el.zstate.classList.add("ok");
  } else if (z.state === "partial") {
    el.zstate.textContent = "部分成功 " + z.added + "，跳过 " + (z.skipped || 0);
    el.zstate.classList.add("bad");
  } else {
    el.zstate.textContent = (z.errors && z.errors[0]) || "失败";
    el.zstate.classList.add("bad");
  }
}

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])
  );
}

async function readCachedZotero() {
  try {
    const data = await chrome.storage.local.get("zoteroStatus");
    const status = data.zoteroStatus;
    if (status && Date.now() - (status.at || 0) < 120000) return status;
  } catch (err) {
    /* ignore */
  }
  return null;
}

function applyZoteroStatus(status) {
  if (!status) return;
  el.zstate.style.cursor = "";

  if (status.ok) {
    el.zotero.disabled = false;
    el.zrow.classList.remove("off");
    if (!state.running) el.zotero.checked = true;
    el.zlabel.textContent = "存入 Zotero" + (status.version ? "（" + status.version + "）" : "");
    el.zlabel.title = "";
    if (!state.job || !state.job.zotero) {
      el.zstate.className = "zstate";
      el.zstate.textContent = "";
    }
  } else {
    // 不锁死：Zotero 也许只是响应慢，允许用户强开
    el.zotero.disabled = false;
    el.zotero.checked = false;
    el.zrow.classList.add("off");
    el.zlabel.textContent = "存入 Zotero（未检测到）";
    el.zlabel.title = status.error || "";
    el.zstate.className = "zstate bad";
    el.zstate.textContent = "重试";
    el.zstate.style.cursor = "pointer";
    el.zstate.title = status.error || "点击重新检测";
  }
}

async function refreshZotero() {
  let status = { ok: false, version: "", error: "" };
  // 刚打开浏览器时 service worker 可能还没就绪，消息会失败，重试几次
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "zotero-ping" });
      if (reply) {
        status = reply;
        if (reply.ok) break;
      }
    } catch (err) {
      status = { ok: false, version: "", error: String(err && err.message) };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  applyZoteroStatus(status);
  if (status.ok) loadZoteroTargets();
  return status;
}

async function loadJob() {
  try {
    const data = await chrome.storage.local.get("activeJob");
    return data.activeJob || null;
  } catch (err) {
    return null;
  }
}

function jobCounts(job) {
  const total = job.tasks.length;
  const done = job.tasks.filter((task) => task.state === "ok").length;
  return { done, total };
}

function renderBanner(job) {
  if (!job) {
    el.banner.hidden = true;
    return;
  }
  const { done, total } = jobCounts(job);
  el.banner.hidden = false;

  if (job.status === "running") {
    el.banner.className = "banner run";
    el.banner.innerHTML =
      "<b>正在下载</b>：" +
      escapeHtml(job.title || job.doi) +
      "<span class='sub'>" +
      done +
      "/" +
      total +
      " · 关掉面板也会继续，重新打开可看进度</span>";
  } else if (job.status === "done") {
    el.banner.className = "banner ok";
    el.banner.innerHTML = "<b>已完成</b>：共保存 " + total + " 个文件";
  } else {
    el.banner.className = "banner bad";
    el.banner.innerHTML =
      "<b>未全部完成</b>：成功 " + done + "/" + total + "，可再点一次重新下载";
  }
}

function stateLabel(task) {
  if (task.state === "ok") return "✓ 已保存";
  if (task.state === "fail") return "✕ " + (task.error || "失败");
  if (task.state === "writing" || task.state === "start") {
    return task.bytes ? Math.max(1, Math.round(task.bytes / 1024)) + " KB" : "下载中";
  }
  return "等待";
}

function classFor(task) {
  if (task.state === "ok") return "row ok";
  if (task.state === "fail") return "row fail";
  if (task.state === "writing" || task.state === "start") return "row work";
  return "row";
}

/* ------------------------------------------------------------ 页面内提取 */

// 注入执行，必须自包含
function extractPageInfo() {
  const meta = (name) => {
    const node = document.querySelector(
      'meta[name="' + name + '"], meta[property="' + name + '"]'
    );
    return node && node.content ? node.content.trim() : "";
  };
  const metaAll = (name) =>
    [...document.querySelectorAll('meta[name="' + name + '"]')]
      .map((n) => (n.content || "").trim())
      .filter(Boolean);

  let doi = meta("citation_doi") || meta("dc.identifier") || meta("prism.doi");
  if (!doi) {
    const fromUrl = location.href.match(/10\.\d{4,9}\/[^\s"'<>?#]+/);
    if (fromUrl) doi = fromUrl[0].replace(/[.,;)\]]+$/, "");
  }
  if (!doi) {
    const text = (document.body && document.body.innerText) || "";
    const found = text.match(/10\.\d{4,9}\/[^\s"'<>]+/);
    if (found) doi = found[0].replace(/[.,;)\]]+$/, "");
  }

  const date =
    meta("citation_publication_date") ||
    meta("citation_online_date") ||
    meta("citation_date") ||
    meta("citation_year") ||
    meta("dc.date") ||
    "";
  const yearMatch = date.match(/\d{4}/);

  const pdfs = [];
  const addPdf = (href) => {
    if (!href) return;
    const clean = href.split("#")[0];
    if (clean && !pdfs.includes(clean)) pdfs.push(clean);
  };
  addPdf(meta("citation_pdf_url"));
  addPdf(meta("bepress_citation_pdf_url"));

  const sis = [];
  const pageKey = location.href.split("#")[0];

  const siMarker = (href) =>
    /(supplementary|supplemental|supporting[-_ ]?information|suppl_file|moesm\d*|_esm\d*|mmc\d+|sapp\d*|suppdata|type=supplementary|media-1)/i.test(
      href
    );
  const siBlock = (href) =>
    /(\/s\/supporting-information|\/site\/|\/help\/|\/faq|\/guidelines|\/about\/|\/author-|\/submit|\/permissions)/i.test(
      href
    );
  const docExt = (href) => /\.(pdf|docx?|pptx?|odt|rtf|xlsx?|csv|txt|zip)(?:[?#]|$)/i.test(href);
  const siFile = (href) =>
    docExt(href) || /[?&]type=supplementary/i.test(href) || /[?&]id=[^&]*\.s\d{3}/i.test(href);
  const pdfHint = (href) =>
    /(\.pdf(?:[?#]|$)|\/pdf\/|pdfdirect|pdfft|\/epdf\/|fulltext\.pdf|type=printable|\/articlepdf\/)/i.test(
      href
    );

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.href || "";
    if (!/^https?:/i.test(href)) continue;
    const clean = href.split("#")[0];
    if (!clean || clean === pageKey) continue;

    const looksSi =
      /(supplementary|supplement|supporting)/i.test(anchor.textContent || "") || siMarker(clean);
    if (looksSi) {
      if (!siBlock(clean) && siFile(clean) && !sis.includes(clean)) sis.push(clean);
      continue;
    }
    if (!pdfs.includes(clean) && pdfHint(clean)) pdfs.push(clean);
  }

  // 兜底：ScienceDirect 的下载按钮有时不是 <a href>，页面上找不到 PDF 链接时
  // 用 PII 拼一个，保证"正文"这一项始终存在（有权限时会 302 到签名地址）。
  if (!pdfs.length) {
    const piiMatch = location.pathname.match(/\/pii\/([A-Za-z0-9]+)/);
    if (piiMatch) {
      addPdf(
        location.origin + "/science/article/pii/" + piiMatch[1].toUpperCase() + "/pdfft"
      );
    }
  }

  return {
    doi: doi || "",
    title: meta("citation_title") || document.title || "",
    authors: metaAll("citation_author"),
    year: yearMatch ? yearMatch[0] : "",
    journal: meta("citation_journal_title") || meta("prism.publicationName") || "",
    issn: meta("citation_issn") || "",
    volume: meta("citation_volume") || "",
    issue: meta("citation_issue") || "",
    pages: (() => {
      const first = meta("citation_firstpage");
      const last = meta("citation_lastpage");
      if (first && last) return first + "-" + last;
      return first || "";
    })(),
    url: location.href,
    pdfs: pdfs.slice(0, 6),
    sis: sis.slice(0, 12),
  };
}

/* ---------------------------------------------------------------- 小工具 */

function sanitize(value, fallback) {
  const cleaned = (value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned || fallback;
}

function slugTitle(title) {
  const ascii = (title || "").normalize("NFKD").replace(/[^\x20-\x7e]/g, " ").toLowerCase();
  const words = ascii.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 9);
  return words.join("-").slice(0, 90) || "paper";
}

function buildFolder(info) {
  let firstAuthor = "Unknown";
  const authors = info.authors || [];
  if (authors.length) {
    const raw = authors[0];
    firstAuthor = raw.includes(",") ? raw.split(",")[0].trim() : raw.split(/\s+/).pop();
  }
  const parts = [info.year, firstAuthor, slugTitle(info.title)].filter(Boolean);
  return sanitize(parts.join("_"), "paper");
}

function fileNameFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    let base = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    if (!base || /^(file|download|attachment|pdf)$/i.test(base)) {
      const id = parsed.searchParams.get("id");
      base = id ? id.replace(/\//g, "_") : fallback;
    }
    return sanitize(base, fallback);
  } catch (err) {
    return fallback;
  }
}

/* ------------------------------------------------------------------ IDB */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  } catch (err) {
    return undefined;
  }
}

async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (err) {
    /* storing the handle is best effort */
  }
}

/* ---------------------------------------------------------------- 渲染 */

function renderInfo() {
  const info = state.info || {};
  if (!info.doi) {
    el.title.textContent = "这页没找到 DOI";
    el.doi.textContent = "停在检索列表页了？打开论文详情页再点一次";
    state.chipsFix = true;
    el.chips.innerHTML = "";
    el.start.disabled = true;
    return;
  }

  el.title.textContent = info.title || "(无标题)";
  el.doi.textContent = info.doi;

  const pdfCount = (info.pdfs || []).length;
  const siCount = (info.sis || []).length;
  el.chips.innerHTML = "";
  const chip = (text, dim) => {
    const span = document.createElement("span");
    span.className = "chip" + (dim ? " dim" : "");
    span.textContent = text;
    el.chips.appendChild(span);
  };
  if (info.year) chip(info.year, true);
  chip(pdfCount ? "正文 1 个" : "未找到正文 PDF", !pdfCount);
  chip(siCount ? `补充材料 ${siCount} 个` : "无补充材料", !siCount);

  if (!pdfCount) {
    el.tip.innerHTML = "这页没有可直接下载的 PDF 链接，可能需要在页面上先取得机构权限。";
    el.start.disabled = true;
    return;
  }

  el.start.disabled = false;
  el.tip.innerHTML =
    "默认存到 <b>下载 / " +
    state.root +
    "/</b> 下；点「选择文件夹…」可以改到任意目录。";
}

function renderFolder() {
  el.folder.textContent = state.dirHandle
    ? state.dirHandle.name + " / " + (state.info ? buildFolder(state.info) : "")
    : "下载 / " + state.root;
}

function renderRows() {
  el.list.innerHTML = "";
  (state.tasks || []).forEach((task, index) => {
    const row = document.createElement("div");
    row.className = classFor(task);
    row.dataset.index = String(index);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = task.label;

    const status = document.createElement("div");
    status.className = "state";
    status.textContent = stateLabel(task);

    row.appendChild(name);
    row.appendChild(status);
    el.list.appendChild(row);
  });
  el.list.classList.add("on");
}

function updateRow(message) {
  const row = el.list.querySelector('.row[data-index="' + message.index + '"]');
  if (!row) return;
  const status = row.querySelector(".state");
  row.className = "row";

  if (message.state === "start") {
    row.classList.add("work");
    status.textContent = "下载中";
  } else if (message.state === "writing") {
    row.classList.add("work");
    status.textContent = message.bytes
      ? Math.max(1, Math.round(message.bytes / 1024)) + " KB"
      : "写入中";
  } else if (message.state === "ok") {
    row.classList.add("ok");
    status.textContent = "✓ 已保存";
  } else if (message.state === "fail") {
    row.classList.add("fail");
    status.textContent = "✕ " + (message.error || "失败");
  }
}

/* ---------------------------------------------------------------- 动作 */

async function chooseFolder() {
  try {
    state.dirHandle = await window.showDirectoryPicker({
      mode: "readwrite",
      id: "doifetch",
      startIn: "documents",
    });
    await idbSet("dir", state.dirHandle);
    renderFolder();
    el.tip.innerHTML = "已选定文件夹，下载会在里面为每篇论文建一个子文件夹。";
  } catch (err) {
    if (err && err.name !== "AbortError") {
      el.tip.textContent = "选择文件夹失败：" + err.message;
    }
  }
}

function buildTasks(info) {
  const tasks = [{ url: info.pdfs[0], name: "main.pdf", label: "正文 PDF" }];
  (info.sis || []).forEach((url, index) => {
    tasks.push({
      url,
      name: fileNameFromUrl(url, "SI-" + (index + 1)),
      label: "补充材料 " + (index + 1),
    });
  });
  return tasks;
}

async function startDownload() {
  if (state.running || !state.info || !state.info.pdfs.length) return;
  state.running = true;
  el.start.disabled = true;
  el.start.textContent = "下载中…";

  const folder = buildFolder(state.info);
  state.tasks = buildTasks(state.info);
  renderRows();

  let targetHandle = null;
  if (state.dirHandle) {
    try {
      let permission = await state.dirHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        permission = await state.dirHandle.requestPermission({ mode: "readwrite" });
      }
      if (permission === "granted") {
        targetHandle = await state.dirHandle.getDirectoryHandle(folder, { create: true });
      } else {
        el.tip.textContent = "没有写入权限，改用浏览器默认下载位置。";
      }
    } catch (err) {
      el.tip.textContent = "文件夹不可用，改用默认下载位置。";
    }
  }

  const job = { tasks: state.tasks, dirHandle: targetHandle, root: state.root };

  // 先把任务写进 storage：面板关掉再打开时，靠它恢复进度
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    doi: state.info.doi,
    title: state.info.title || "",
    mode: targetHandle ? "folder" : "downloads",
    startedAt: Date.now(),
    finishedAt: 0,
    status: "running",
    zoteroWanted: Boolean(el.zotero.checked) && !el.zotero.disabled,
    zoteroTarget: el.ztarget && !el.ztarget.hidden ? el.ztarget.value || "" : "",
    meta: {
      doi: state.info.doi,
      title: state.info.title,
      url: state.info.url,
      authors: state.info.authors,
      year: state.info.year,
      journal: state.info.journal,
      issn: state.info.issn,
      volume: state.info.volume,
      issue: state.info.issue,
      pages: state.info.pages,
    },
    tasks: state.tasks.map((task) => ({
      label: task.label,
      name: task.name,
      url: task.url,
      state: "pending",
      error: "",
      bytes: 0,
    })),
  };
  state.job = record;
  renderBanner(record);

  try {
    await chrome.runtime.sendMessage({ type: "prepare" });
  } catch (err) {
    /* offscreen may already exist */
  }

  try {
    await chrome.runtime.sendMessage({ type: "run", job, record });
  } catch (err) {
    // 句柄无法跨上下文传递时退化为浏览器下载
    el.tip.textContent = "文件夹模式不可用，已改用浏览器默认下载位置。";
    record.mode = "downloads";
    await chrome.runtime.sendMessage({
      type: "run",
      job: { tasks: state.tasks, dirHandle: null, root: state.root + "/" + folder },
      record,
    });
  }
}

/* ---------------------------------------------------------------- 进度 */

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "progress") return;

  if (message.batch) {
    renderBatch(message.batch);
    return;
  }

  if (message.zotero) {
    renderZotero(message.zotero);
    if (state.job) state.job.zotero = message.zotero;
    return;
  }

  // 同步一份到本地记录，横幅才能跟着走
  if (state.job && typeof message.index === "number") {
    const task = state.job.tasks[message.index];
    if (task) {
      task.state = message.state;
      if (message.error) task.error = message.error;
      if (message.bytes) task.bytes = message.bytes;
    }
  }

  if (typeof message.index === "number") {
    updateRow(message);
    if (state.job) renderBanner(state.job);
    return;
  }

  state.running = false;
  el.start.disabled = false;
  el.start.textContent = "开始下载";

  if (state.job) {
    state.job.status = message.state;
    state.job.finishedAt = Date.now();
    renderBanner(state.job);
  }

  if (message.state === "done") {
    el.tip.innerHTML = `<b>完成</b>：${message.done} 个文件已保存${
      state.dirHandle ? "到你选的文件夹" : "到「下载」目录"
    }。`;
  } else if (message.state === "partial") {
    el.tip.innerHTML = `<b>部分完成</b>：${message.done}/${message.total} 成功，其余看上面的行。`;
  } else {
    el.tip.innerHTML = `<b>失败</b>：${message.error || "全部未保存"}，可换个文件夹或稍后重试。`;
  }
});

/* ---------------------------------------------------------------- 启动 */

(async function init() {
  const storedRoot = await idbGet("root");
  if (storedRoot) state.root = storedRoot;
  const storedHandle = await idbGet("dir");
  if (storedHandle) state.dirHandle = storedHandle;

  el.pick.addEventListener("click", chooseFolder);
  el.start.addEventListener("click", startDownload);

  // 批量取件
  el.batchStart.addEventListener("click", startBatch);
  el.diagBtn.addEventListener("click", diagnoseCurrentPage);
  el.batchText.addEventListener("input", () => {
    const count = parseDois(el.batchText.value).length;
    el.batchHint.className = "bhint";
    el.batchHint.textContent = count ? `识别到 ${count} 个 DOI` : "";
  });
  try {
    const saved = await chrome.storage.local.get("wvpnBase");
    if (saved && saved.wvpnBase) el.wvpnBase.value = saved.wvpnBase;
  } catch (err) {
    /* ignore */
  }
  refreshBatch();

  // 未检测到时，「重试」字样可点（在 label 里，要阻止它连带切换勾选）
  el.zstate.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    el.zstate.textContent = "检测中…";
    el.zstate.style.cursor = "";
    refreshZotero();
  });

  // Zotero 是否在运行：先用缓存立即渲染，再刷新一次
  applyZoteroStatus(await readCachedZotero());
  refreshZotero();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("no tab");
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageInfo,
    });
    state.info = (injection && injection.result) || { doi: "" };
  } catch (err) {
    state.info = { doi: "" };
  }

  renderInfo();
  renderFolder();

  // 恢复上一次的任务：面板被关掉再打开时，这里接上进度
  const job = await loadJob();
  state.job = job;
  renderBanner(job);

  if (job && job.status === "running") {
    state.running = true;
    state.tasks = job.tasks;
    renderRows();
    el.start.disabled = true;
    el.start.textContent = "正在下载…";

    const samePaper = Boolean(job.doi) && job.doi === (state.info && state.info.doi);
    if (!samePaper) {
      el.tip.innerHTML =
        "另一个任务正在进行，等它完成后再开始新的。进度见上方横幅，也可以直接关掉面板——下载会继续。";
    }
  } else if (job && job.tasks && job.tasks.length) {
    // 上一次已完成/未完成：也把文件列出来，方便确认存了几个
    state.tasks = job.tasks;
    renderRows();
  }

  if (job && job.zotero) renderZotero(job.zotero);
})();

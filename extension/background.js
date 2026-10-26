// DOI 取件器 · 后台
// 除了路由下载，还负责把任务状态写进 storage.local —— 面板关掉再打开能接着看。

importScripts("webvpn.js");

const OFFSCREEN_PATH = "offscreen.html";
const JOB_KEY = "activeJob";
const RECENT_KEY = "recentJobs";
const RECENT_LIMIT = 20;

// Zotero 的本地 connector 服务（Zotero 运行时监听）
const ZOTERO = "http://127.0.0.1:23119";
const ZOTERO_MAX_MB = 40;
// Zotero 会拒绝一切带 Origin 且没有这个头的请求（防网页乱调），扩展必须带上
const ZOTERO_API_HEADER = { "X-Zotero-Connector-API-Version": "3" };

async function zoteroPingOnce(timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ZOTERO + "/connector/ping", {
      method: "POST",
      headers: { ...ZOTERO_API_HEADER },
      body: "ping",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, version: "", error: "HTTP " + response.status };
    }
    return { ok: true, version: response.headers.get("X-Zotero-Version") || "", error: "" };
  } catch (err) {
    return { ok: false, version: "", error: err.name + ": " + err.message };
  } finally {
    clearTimeout(timer);
  }
}

// 弹窗刚打开时 service worker 可能还在启动，单次失败不代表 Zotero 没开
async function zoteroPing(attempts = 3, timeoutMs = 2500) {
  let last = { ok: false, version: "", error: "" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await zoteroPingOnce(timeoutMs);
    if (last.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  try {
    await chrome.storage.local.set({ zoteroStatus: { ...last, at: Date.now() } });
  } catch (err) {
    /* 缓存失败不影响结果 */
  }
  return last;
}

function toCreators(authors) {
  return (authors || []).slice(0, 60).map((raw) => {
    const value = String(raw || "").trim();
    if (!value) return null;
    if (value.includes(",")) {
      const [last, ...rest] = value.split(",");
      return {
        creatorType: "author",
        lastName: last.trim(),
        firstName: rest.join(",").trim(),
      };
    }
    const parts = value.split(/\s+/);
    if (parts.length === 1) {
      return { creatorType: "author", lastName: value, firstName: "" };
    }
    return {
      creatorType: "author",
      lastName: parts.pop(),
      firstName: parts.join(" "),
    };
  }).filter(Boolean);
}

// Zotero 自己的 DOI 翻译器底层也是查 Crossref，所以我们直接取同一份权威元数据，
// 比抓页面 meta 完整（期刊、卷、期、页码、ISSN 往往页面上没有）。
async function crossrefMeta(doi) {
  if (!doi) return null;
  try {
    const response = await fetch(
      "https://api.crossref.org/works/" + encodeURIComponent(doi),
      { headers: { Accept: "application/json" } }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const message = payload && payload.message;
    if (!message) return null;

    const first = (value) => (Array.isArray(value) ? value[0] : value) || "";
    const yearOf = (block) => {
      const parts = block && block["date-parts"] && block["date-parts"][0];
      return parts && parts[0] ? String(parts[0]) : "";
    };

    const authors = (message.author || [])
      .map((author) => {
        if (!author) return "";
        const family = (author.family || "").trim();
        const given = (author.given || "").trim();
        if (family && given) return family + ", " + given;
        if (family) return family;
        return (author.name || "").trim();
      })
      .filter(Boolean);

    const date =
      message["published-print"] ||
      message["published-online"] ||
      message.issued ||
      message.created;

    return {
      title: first(message.title),
      authors,
      year: yearOf(date),
      journal: first(message["container-title"]),
      publisher: message.publisher || "",
      volume: message.volume || "",
      issue: message.issue || "",
      pages: message.page || "",
      issn: first(message.ISSN),
      doi: message.DOI || doi,
      url: message.URL || "",
    };
  } catch (err) {
    return null;
  }
}

function mergeMeta(pageMeta, authoritative) {
  const merged = { ...(pageMeta || {}) };
  if (!authoritative) return merged;
  // 权威源存在时优先用它的字段，页面 meta 只补空缺
  for (const key of ["title", "authors", "year", "journal", "volume", "issue", "pages", "issn", "doi", "url"]) {
    const value = authoritative[key];
    if (Array.isArray(value) ? value.length : value) merged[key] = value;
  }
  return merged;
}

// 目录选择：getSelectedCollection 返回分类树；updateSession 用来把条目挪到别的分类
async function zoteroCollections() {
  try {
    const response = await fetch(ZOTERO + "/connector/getSelectedCollection", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ZOTERO_API_HEADER },
      body: "{}",
    });
    if (!response.ok) {
      return { ok: false, targets: [], error: "HTTP " + response.status };
    }
    const data = await response.json();
    return {
      ok: true,
      current: { id: data.id || "", name: data.name || "" },
      targets: data.targets || [],
    };
  } catch (err) {
    return { ok: false, targets: [], error: String(err && err.message) };
  }
}

async function zoteroUpdateTarget(sessionID, target) {
  try {
    const response = await fetch(ZOTERO + "/connector/updateSession", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ZOTERO_API_HEADER },
      body: JSON.stringify({ sessionID, target, tags: [], note: "" }),
    });
    return response.ok;
  } catch (err) {
    return false;
  }
}

function buildZoteroItem(meta) {  const item = {
    id: "doifetch-main",
    itemType: "journalArticle",
    title: meta.title || "",
    creators: toCreators(meta.authors),
    DOI: meta.doi || "",
    url: meta.url || "",
    libraryCatalog: "DOI 取件器",
  };
  if (meta.year) item.date = meta.year;
  if (meta.journal) item.publicationTitle = meta.journal;
  if (meta.issn) item.ISSN = meta.issn;
  if (meta.volume) item.volume = meta.volume;
  if (meta.issue) item.issue = meta.issue;
  if (meta.pages) item.pages = meta.pages;
  return item;
}

// HTTP 头只能是 ISO-8859-1，而附件标题常含中文；转成 \uXXXX 后 JSON.parse 会还原
function asciiJsonHeader(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function guessMime(task, contentType) {  const fromHeader = (contentType || "").split(";")[0].trim();
  if (fromHeader && fromHeader !== "application/octet-stream") return fromHeader;
  const name = (task.name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (name.endsWith(".doc")) return "application/msword";
  if (name.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (name.endsWith(".xls")) return "application/vnd.ms-excel";
  if (name.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".csv")) return "text/csv";
  return "application/pdf";
}

async function pushToZotero(job) {
  const tasks = job.tasks || [];
  const result = { state: "running", added: 0, skipped: 0, errors: [], meta: "page" };

  const update = async () => {
    const current = await readJob();
    if (!current || current.id !== job.id) return;
    current.zotero = result;
    await writeJob(current);
    report({ zotero: { ...result } });
  };
  await update();

  const ping = await zoteroPing(1);
  if (!ping.ok) {
    result.state = "fail";
    result.errors.push("Zotero 没有响应：" + (ping.error || "未知原因"));
    await update();
    return result;
  }

  // 元数据：DOI 存在时用 Crossref（与 Zotero 的 DOI 翻译器同源）
  let meta = job.meta || {};
  if (meta.doi) {
    const authoritative = await crossrefMeta(meta.doi);
    if (authoritative && authoritative.title) {
      meta = mergeMeta(meta, authoritative);
      result.meta = "crossref";
      await update();
    }
  }

  const sessionID = "doifetch-" + job.id;
  const parentKey = "doifetch-main";

  try {
    const response = await fetch(ZOTERO + "/connector/saveItems", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ZOTERO_API_HEADER },
      body: JSON.stringify({
        sessionID,
        uri: meta.url || "",
        items: [buildZoteroItem(meta)],
      }),
    });
    if (!response.ok && response.status !== 201) {
      throw new Error("saveItems HTTP " + response.status);
    }
  } catch (err) {
    result.state = "fail";
    result.errors.push("建档失败：" + err.message);
    await update();
    return result;
  }

  // 用户指定了别的分类：条目已经存进「当前选中」，这里整条挪过去
  if (job.zoteroTarget) {
    const moved = await zoteroUpdateTarget(sessionID, job.zoteroTarget);
    result.target = job.zoteroTarget;
    if (!moved) result.errors.push("切换到指定分类失败，条目留在当前分类");
    await update();
  }

  for (const task of tasks) {
    if (!task.url) {
      result.skipped += 1;
      continue;
    }
    try {
      const fileResponse = await fetch(task.url, { credentials: "include" });
      if (!fileResponse.ok) throw new Error("HTTP " + fileResponse.status);

      const declared = Number(fileResponse.headers.get("Content-Length") || 0);
      if (declared > ZOTERO_MAX_MB * 1024 * 1024) {
        result.skipped += 1;
        continue;
      }
      const blob = await fileResponse.blob();
      if (blob.size > ZOTERO_MAX_MB * 1024 * 1024) {
        result.skipped += 1;
        continue;
      }

      const mime = guessMime(task, fileResponse.headers.get("Content-Type"));
      const metadata = {
        sessionID,
        parentItemID: parentKey,
        title: task.label || task.name || "附件",
        url: task.url,
      };

      const saved = await fetch(
        ZOTERO + "/connector/saveAttachment?sessionID=" + encodeURIComponent(sessionID),
        {
          method: "POST",
          headers: {
            "Content-Type": mime,
            "X-Metadata": asciiJsonHeader(metadata),
            ...ZOTERO_API_HEADER,
          },
          body: blob,
        }
      );
      if (saved.ok || saved.status === 201) result.added += 1;
      else result.errors.push(`${task.label}：HTTP ${saved.status}`);
    } catch (err) {
      result.errors.push(`${task.label}：${err.message}`);
    }
    await update();
  }

  result.state = result.added
    ? result.errors.length
      ? "partial"
      : "ok"
    : "fail";
  await update();
  return result;
}


async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "在面板关闭后继续把论文写入用户选择的文件夹",
    });
  } catch (err) {
    if (!String(err && err.message).includes("single offscreen")) throw err;
  }
}

function report(payload) {
  chrome.runtime.sendMessage({ type: "progress", ...payload }).catch(() => {});
}

function updateBadge(message) {
  const { done, total, state } = message;
  if (state === "done") {
    chrome.action.setBadgeBackgroundColor({ color: "#0f7a4d" });
    chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
  } else if (state === "fail") {
    chrome.action.setBadgeBackgroundColor({ color: "#a11224" });
    chrome.action.setBadgeText({ text: "!" });
  } else if (typeof done === "number") {
    chrome.action.setBadgeBackgroundColor({ color: "#444444" });
    chrome.action.setBadgeText({ text: `${done}/${total}` });
  }
}

// worker 自己发的消息收不到自己，所以默认下载模式必须就地落库 + 就地更新徽标
async function emit(payload) {
  const message = { type: "progress", ...payload };
  updateBadge(message);
  try {
    await applyProgress(message);
  } catch (err) {
    /* 记录失败不影响下载 */
  }
  report(payload);
}

/* ------------------------------------------------------------ 任务状态 */

async function readJob() {
  const data = await chrome.storage.local.get(JOB_KEY);
  return data[JOB_KEY] || null;
}

async function writeJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

function newJob(payload, tasks) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    doi: payload.doi || "",
    title: payload.title || "",
    mode: payload.mode || "downloads",
    startedAt: Date.now(),
    finishedAt: 0,
    status: "running",
    tasks: tasks.map((task) => ({ ...task, state: "pending", error: "", bytes: 0 })),
  };
}

async function applyProgress(message) {
  const job = await readJob();
  if (!job) return;

  if (typeof message.index === "number") {
    const task = job.tasks[message.index];
    if (!task) return;
    task.state = message.state;
    if (message.error) task.error = message.error;
    if (message.bytes) task.bytes = message.bytes;
    await writeJob(job);
    return;
  }

  job.status = message.state;
  job.finishedAt = Date.now();
  await writeJob(job);

  if (message.state === "done" || message.state === "partial") {
    notifyDone(job, message);
  }
  pushRecent(job);

  // 下载结束后再把附件推进 Zotero（需要文件 URL，所以放在这里）
  if (job.zoteroWanted && !job.zotero) {
    pushToZotero(job).catch(() => {});
  }
}

async function pushRecent(job) {
  const data = await chrome.storage.local.get(RECENT_KEY);
  const recent = (data[RECENT_KEY] || []).slice(0, RECENT_LIMIT);
  recent.unshift({
    doi: job.doi,
    title: job.title,
    status: job.status,
    finishedAt: job.finishedAt,
    saved: job.tasks.filter((task) => task.state === "ok").length,
    total: job.tasks.length,
  });
  await chrome.storage.local.set({ [RECENT_KEY]: recent.slice(0, RECENT_LIMIT) });
}

/* -------------------------------------------------------------- 通知 */

function notifyDone(job, message) {
  const saved = job.tasks.filter((task) => task.state === "ok").length;
  const total = job.tasks.length;
  const ok = message.state === "done";
  const title = ok ? `已保存 ${saved} 个文件` : `部分完成 ${saved}/${total}`;
  const body = (job.title || job.doi || "").slice(0, 90);

  try {
    chrome.notifications.create(`doifetch-${job.id}`, {
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message: body || "DOI 取件器",
      priority: ok ? 0 : 1,
    });
  } catch (err) {
    /* icon 缺失时通知会失败，不影响下载 */
  }
}

/* ------------------------------------------------------------ 下载路由 */

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      const error = chrome.runtime.lastError;
      if (error || id === undefined) reject(new Error(error ? error.message : "下载失败"));
      else resolve(id);
    });
  });
}

function waitForDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(state);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") finish("complete");
      if (delta.state.current === "interrupted") finish("interrupted");
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function runDownloads(job) {
  const { tasks, root } = job;
  const total = tasks.length;
  let done = 0;

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    await emit({ index, total, name: task.label, state: "start" });
    try {
      const id = await startDownload({
        url: task.url,
        filename: root + "/" + task.name,
        saveAs: false,
        conflictAction: "uniquify",
      });
      const state = await waitForDownload(id, 180000);
      if (state === "complete") {
        done += 1;
        await emit({ index, total, name: task.label, state: "ok" });
      } else {
        await emit({
          index,
          total,
          name: task.label,
          state: "fail",
          error: state === "interrupted" ? "被浏览器中断" : "超时",
        });
      }
    } catch (err) {
      await emit({ index, total, name: task.label, state: "fail", error: err.message });
    }
  }

  await emit({
    state: done === total ? "done" : done > 0 ? "partial" : "fail",
    done,
    total,
  });
}

/* ------------------------------------------------------------ 批量队列 */

const BATCH_KEY = "batchState";
const BATCH_ROOT = "DOI取件器/批量";
const BATCH_TIMEOUT_MS = 4 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function doiSlug(doi) {
  return (doi || "").replace(/[^0-9a-zA-Z._-]+/g, "-").slice(0, 80) || "item";
}

/* 注入到论文页里，只读取、不修改 */
function sniffPage() {
  const meta = document.querySelector('meta[name="citation_pdf_url"]');
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const pdfLinks = anchors
    .map((anchor) => anchor.href)
    .filter((href) => /\/pdfft|\.pdf(\?|$)|\/pdf(\?|$)/i.test(href));
  // 注意：注入到页面的函数必须自包含，不能引用 service worker 里的变量
  const siPattern = /supplement|supporting|moesm|_esm|_si_|appendix|additional-file|补充|附加/i;
  const siLinks = anchors
    .filter((anchor) => siPattern.test(anchor.href) || siPattern.test(anchor.textContent || ""))
    .map((anchor) => anchor.href);
  return {
    title: document.title,
    ready: document.readyState,
    meta: meta ? meta.content : "",
    links: pdfLinks.slice(0, 5),
    si: Array.from(new Set(siLinks)).slice(0, 20),
    url: location.href,
  };
}

async function readBatch() {
  const data = await chrome.storage.local.get(BATCH_KEY);
  return data[BATCH_KEY] || null;
}

async function writeBatch(state) {
  try {
    await chrome.storage.local.set({ [BATCH_KEY]: state });
  } catch (err) {
    /* ignore */
  }
  report({ batch: state });
  return state;
}

/** PDF 若是绝对地址且启用了网关，就改写回网关形式，避免绕开校内会话 */
function pickPdfUrl(info, base) {
  const candidates = [info.meta, ...(info.links || [])].filter(Boolean);
  for (const raw of candidates) {
    let url = String(raw).trim();
    if (!url) continue;
    if (base && /^https?:\/\//i.test(url) && !url.startsWith(base)) {
      url = DOIWebVPN.convert(url, base);
    }
    return url;
  }
  return "";
}

function notifyBatch(text) {
  try {
    chrome.notifications.create("", {
      type: "basic",
      iconUrl: "icon128.png",
      title: "DOI 取件器 · 批量",
      message: String(text).slice(0, 200),
    });
  } catch (err) {
    /* 通知失败不影响流程 */
  }
}

function pickSiUrls(info, base, pdfUrl) {
  const seen = new Set([pdfUrl]);
  const out = [];
  for (const raw of (info && info.si) || []) {
    let url = String(raw).trim();
    if (!url) continue;
    if (base && /^https?:\/\//i.test(url) && !url.startsWith(base)) {
      url = DOIWebVPN.convert(url, base);
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function siFilename(url, index) {
  let name = "";
  try {
    const parsed = new URL(url);
    name = decodeURIComponent((parsed.pathname.split("/").pop() || "").trim());
  } catch (err) {
    name = "";
  }
  name = name.replace(/[\\/:*?"<>|]+/g, "-").trim();
  if (!name || name.length > 90) name = "SI-" + index;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ".pdf";
  return name;
}

/**
 * 只读响应开头的几个字节，判断到底拿回的是什么。
 *
 * 不能等下载完再看文件名：Chrome 按 Content-Type 决定扩展名，而验证页返回的
 * HTML 会被存成 .html（用户看到的就是 main.html）。先探一次文件头，既准确又
 * 不会把验证页落到磁盘上，也省得为几十 MB 的 PDF 先猜后错。
 */
async function probeDocument(url) {
  let response = null;
  try {
    response = await fetch(url, { credentials: "include", redirect: "follow" });
  } catch (err) {
    return { kind: "error", reason: "连不上：" + (err && err.message) };
  }
  if (!response.ok) {
    return { kind: "error", reason: "HTTP " + response.status };
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let head = "";
  try {
    const reader = response.body.getReader();
    const chunk = await reader.read();
    reader.cancel().catch(() => {});
    const bytes = (chunk && chunk.value) || new Uint8Array();
    head = new TextDecoder("latin1").decode(bytes.slice(0, 64));
  } catch (err) {
    return { kind: "error", reason: "读取响应失败" };
  }

  const trimmed = head.replace(/^\s+/, "");
  if (trimmed.startsWith("%PDF-")) return { kind: "pdf", contentType };
  if (
    trimmed.startsWith("<") ||
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml")
  ) {
    return { kind: "html", reason: contentType || "HTML 页面" };
  }
  if (trimmed.startsWith("PK")) return { kind: "zip", contentType };
  if (trimmed.startsWith("{")) return { kind: "json", contentType };
  return { kind: "other", contentType };
}

/**
 * 先探类型、再下载，落盘后仍然核对一次文件名。
 *
 * requirePdf=true 时只接受 %PDF-；补充材料允许 xlsx/zip/docx 等，但拒绝 HTML。
 */
async function downloadVerified(url, filename, requirePdf) {
  const probe = await probeDocument(url);

  // 明确是 HTML 就不必下载了
  if (probe.kind === "html") {
    return { ok: false, reason: "拿到的是网页，不是 PDF（多半是验证页或没有权限）" };
  }
  // 探测本身失败（跨域、被网关拒、超时）不代表文件有问题——
  // downloads 的请求特征和 fetch 不同，可能只有后者被拦。交给落盘结果裁决。
  if (probe.kind !== "pdf" && probe.kind !== "error" && requirePdf) {
    return { ok: false, reason: "拿到的是 " + probe.kind + "，不是 PDF" };
  }

  let id = null;
  try {
    id = await startDownload({ url, filename, conflictAction: "uniquify" });
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }

  const outcome = await waitForDownload(id, 180000);
  let record = null;
  try {
    const found = await chrome.downloads.search({ id });
    record = (found && found[0]) || null;
  } catch (err) {
    record = null;
  }

  const savedName = record ? String(record.filename || "").split(/[\\/]/).pop() : "";
  const landedHtml = /\.html?$/i.test(savedName);

  if (outcome === "complete" && !landedHtml) {
    return { ok: true, name: savedName, size: (record && record.fileSize) || 0 };
  }

  // 兜底：内容类型判断没拦住、却仍然落成网页 → 删掉，别留垃圾
  try {
    await chrome.downloads.removeFile(id);
  } catch (err) {
    /* ignore */
  }
  try {
    await chrome.downloads.erase({ id });
  } catch (err) {
    /* ignore */
  }

  if (outcome !== "complete") {
    return { ok: false, reason: outcome === "timeout" ? "下载超时" : "下载中断" };
  }
  if (landedHtml) {
    return { ok: false, reason: "落盘成了网页（" + savedName + "），已删除" };
  }
  return { ok: false, reason: "下载完成但内容无法确认（" + (savedName || "未知文件名") + "）" };
}

/* ------------------------------------------------- 浏览器原生导航下载 */

/**
 * Elsevier 的 /pdfft 端点返回一张反爬中间页（noindex + nojspx），只有让标签页
 * 真正导航过去、跑完它的 JS，浏览器才会发起文件下载。fetch() 和
 * downloads.download() 都拿不到 PDF —— 这正是之前存成 main.html 的原因。
 *
 * 这里导航后监听 downloads，并用 onDeterminingFilename 把文件落到我们的目录。
 */
let nameHint = null;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const hint = nameHint;
  if (!hint) return false;
  const looksPdf =
    /application\/pdf/i.test(item.mime || "") ||
    /\/pdfft|els-cdn|sciencedirect|\.pdf(\?|$)/i.test(item.url || "");
  if (!looksPdf) return false;
  nameHint = null;
  suggest({ filename: hint.folder + "/" + hint.name, conflictAction: "uniquify" });
  return true;
});

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageStatus(tabId) {
  try {
    const [done] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title,
        text: (document.body ? document.body.innerText : "").slice(0, 300),
        html: document.documentElement ? document.documentElement.innerHTML.slice(0, 600) : "",
      }),
    });
    return (done && done.result) || null;
  } catch (err) {
    return null;
  }
}

function looksLikeGate(status) {
  if (!status) return false;
  const blob = ((status.title || "") + " " + (status.text || "") + " " + (status.html || "")).toLowerCase();
  return (
    blob.includes("nojspx") ||
    blob.includes("noindex") ||
    blob.includes("just a moment") ||
    blob.includes("请稍候") ||
    blob.includes("verify you are human") ||
    blob.includes("are you a robot")
  );
}

/** 给出版商地址加上"以附件形式下载"的参数（Elsevier 支持 download=true） */
function withDownloadFlag(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("download", "true");
    if (/sciencedirect\.com/.test(parsed.hostname)) {
      parsed.searchParams.set("isDTMRedir", "true");
    }
    return parsed.toString();
  } catch (err) {
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "download=true";
  }
}

/** 等一次新的浏览器下载落地（最多 timeoutMs） */
async function grabFreshDownload(startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleepMs(1200);
    let recent = [];
    try {
      recent = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 3 });
    } catch (err) {
      recent = [];
    }
    const fresh = recent.find(
      (item) => item.startTime && Date.parse(item.startTime) >= startedAt - 2000
    );
    if (!fresh) continue;

    const outcome = await waitForDownload(fresh.id, 180000);
    const saved = String(fresh.filename || "").split(/[\\/]/).pop();
    if (outcome === "complete" && !/\.html?$/i.test(saved)) {
      return { ok: true, name: saved, size: fresh.fileSize || 0 };
    }
    if (outcome !== "complete") {
      return { ok: false, reason: outcome === "timeout" ? "下载超时" : "下载中断" };
    }
    return { ok: false, reason: "落盘成了网页（" + saved + "）" };
  }
  return null;
}

/**
 * 取回被中间页保护的 PDF。
 *
 * 实测结论：Elsevier 的 /pdfft 对 fetch / downloads API 一律返回 403（页面里还带
 * tdm-reservation 声明），但**浏览器导航**能正常打开 PDF —— 只是内联显示在阅读器
 * 里，不会触发下载事件。所以按下面的顺序逐级尝试，并把每一步结果写进诊断：
 *
 *   1. 带 download=true 导航（让服务端返回 attachment，触发真正的下载）
 *   2. 带 download=true 直接下载
 *   3. 正常导航（阅读器显示）后主动下载
 *   4. 都失败 → 交给用户：PDF 已经打开，用阅读器的下载按钮保存
 */
async function downloadViaNavigation(tabId, url, folder, name, timeoutMs, onGate) {
  const tried = [];
  const attachName = () => { nameHint = { folder, name }; };

  const attemptNavigate = async (target, label) => {
    attachName();
    const startedAt = Date.now();
    try {
      await chrome.tabs.update(tabId, { url: target });
    } catch (err) {
      nameHint = null;
      tried.push(label + ": 打不开");
      return null;
    }
    const got = await grabFreshDownload(startedAt, 15000);
    if (got && got.ok) {
      nameHint = null;
      return { ...got, via: label };
    }
    if (got && !got.ok) tried.push(label + ": " + got.reason);
    return null;
  };

  // 1) 带 download=true 导航
  const flagged = withDownloadFlag(url);
  if (flagged !== url) {
    const one = await attemptNavigate(flagged, "导航+download=true");
    if (one) return one;
  }

  // 2) 带 download=true 直接下载
  try {
    const direct = await downloadVerified(flagged, folder + "/" + name, true);
    if (direct.ok) {
      nameHint = null;
      return { ...direct, via: "直下+download=true" };
    }
    tried.push("直下+download=true: " + direct.reason);
  } catch (err) {
    tried.push("直下抛错");
  }

  // 3) 正常导航 → 等中间页消失 → 主动下载
  const gateStart = Date.now();
  attachName();
  let gateReported = false;
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    nameHint = null;
    return { ok: false, reason: "打不开 PDF 地址" };
  }

  const deadline = gateStart + timeoutMs;
  let lastTry = 0;
  let viewerSeen = false;

  while (Date.now() < deadline) {
    await sleepMs(1500);

    const fresh = await grabFreshDownload(gateStart, 1);
    if (fresh && fresh.ok) {
      nameHint = null;
      return { ...fresh, via: "导航后自动下载" };
    }

    const status = await pageStatus(tabId);
    if (status === null) viewerSeen = true; // 注入失败 = 已经是 PDF 阅读器

    if (looksLikeGate(status)) {
      if (!gateReported) {
        gateReported = true;
        try {
          await chrome.tabs.update(tabId, { active: true });
        } catch (err) {
          /* ignore */
        }
        if (typeof onGate === "function") onGate();
      }
      continue;
    }

    if (Date.now() - lastTry > 6000) {
      lastTry = Date.now();
      const direct = await downloadVerified(url, folder + "/" + name, true);
      if (direct.ok) {
        nameHint = null;
        return { ...direct, via: "阅读器就绪后主动下载" };
      }
      tried.push("主动下载: " + direct.reason);
    }
  }

  nameHint = null;
  if (viewerSeen || !looksLikeGate(await pageStatus(tabId))) {
    return {
      ok: false,
      manual: true,
      reason: "PDF 已在标签页里打开，但无法直接保存：请在阅读器里点下载按钮（或 Ctrl+S）存到 " +
        folder + "/" + name,
      tried,
    };
  }
  return { ok: false, reason: "等待超时（页面可能仍需人工验证）", tried, gate: gateReported };
}

/**
 * 生成候选 PDF 地址。
 *
 * 页面里的 /pdfft 链接带 md5，而 md5 是**页面加载时生成**的；人工验证后页面
 * 重新渲染，旧 md5 就失效了（表现为一直 403）。所以除了原样使用，再按 PII
 * 拼两种干净地址（这是 metapub/findit 的做法）：
 *   /science/article/pii/{PII}/pdfft?isDTMRedir=true&download=true
 *   /science/article/pii/{PII}/pdfft
 */
function pdfVariants(url, base) {
  const out = [url];
  try {
    const parsed = new URL(url);
    const matched = parsed.pathname.match(/\/pii\/([A-Za-z0-9]+)/);
    const pii = matched ? matched[1].toUpperCase() : "";
    if (/^[A-Z0-9]{8,}$/.test(pii)) {
      const shapes = [
        "https://www.sciencedirect.com/science/article/pii/" + pii + "/pdfft?isDTMRedir=true&download=true",
        "https://www.sciencedirect.com/science/article/pii/" + pii + "/pdfft",
      ];
      for (const shape of shapes) {
        out.push(base ? DOIWebVPN.convert(shape, base) : shape);
      }
    }
  } catch (err) {
    /* ignore */
  }
  return Array.from(new Set(out));
}

async function runBatch(dois, base) {
  const state = {
    id: "b" + Date.now().toString(36),
    base: base || "",
    root: BATCH_ROOT,
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    current: 0,
    items: dois.map((doi) => ({ doi, status: "pending", detail: "", pdf: "", landing: "" })),
  };
  await writeBatch(state);

  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    state.current = index;
    item.status = "working";
    await writeBatch(state);

    // 关键：doi.org 会 302 到出版商的真实地址。若先把 doi.org 包进网关，
    // 这次重定向会把页面带回未改写的地址，等于中途退出网关（付费墙 + 挑战页）。
    // 所以先解析出落地地址，再决定包不包。
    let landing = "https://doi.org/" + item.doi;
    try {
      const resolved = await fetch(landing, { redirect: "follow" });
      if (resolved && resolved.url) landing = resolved.url;
    } catch (err) {
      /* 解析失败就用 doi.org 兜底 */
    }
    item.landing = landing;

    const target = base ? DOIWebVPN.convert(landing, base) : landing;

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: target, active: false });
    } catch (err) {
      item.status = "failed";
      item.detail = "打不开标签页：" + (err && err.message);
      await writeBatch(state);
      continue;
    }

    const folder = state.root + "/" + doiSlug(item.doi);
    item.si = item.si || [];

    let pdf = "";
    let download = null;
    let challenged = false;
    let lastInfo = null;
    let attempts = 0;
    let viewerSeen = false;
    const tried = new Set();
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let settleDeadline = 0;

    while (Date.now() < deadline) {
      await sleep(1500);

      let info = null;
      try {
        // 所有 frame 都嗅一遍：有些出版社会把 PDF 嵌在 iframe 里
        const frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: sniffPage,
        });
        const found = (frames || [])
          .map((frame) => frame && frame.result)
          .filter(Boolean)
          .sort(
            (a, b) =>
              (b.links || []).length + (b.si || []).length -
              ((a.links || []).length + (a.si || []).length)
          );
        info = found[0] || null;
      } catch (err) {
        info = null; // 页面正在跳转，或已经变成 PDF 阅读器（插件文档，无法注入）
      }

      if (!info) {
        // 阅读器出现了：注入一定失败，但 PDF 就在这个标签页里 —— 直接从它的
        // 地址再取一次（此时会话已通过验证，请求多半能成功）
        let tabUrl = "";
        try {
          tabUrl = (await chrome.tabs.get(tab.id)).url || "";
        } catch (err) {
          tabUrl = "";
        }
        if (/\/pdfft|\.pdf(\?|$)/i.test(tabUrl)) {
          viewerSeen = true;
          const viewerUrls = pdfVariants(tabUrl, base).filter((url) => !tried.has(url));
          for (const url of viewerUrls) tried.add(url);
          for (const url of viewerUrls) {
            const got = await downloadVerified(url, folder + "/main.pdf", true);
            if (got.ok) {
              download = got;
              pdf = url;
              break;
            }
            if (!(download && download.ok)) download = got;
          }
          if (download && download.ok) break;
        }
        continue;
      }

      // 卡在验证页 / 网关登录页：等人操作，但**绝不动这个标签页**
      const needsHuman =
        DOIWebVPN.isChallengeTitle(info.title) || DOIWebVPN.isLoginUrl(info.url);
      if (needsHuman) {
        if (!challenged) {
          challenged = true;
          const login = DOIWebVPN.isLoginUrl(info.url);
          item.status = "challenge";
          item.detail = login
            ? "网关需要登录：在这个标签页登录一次，登录后会自动继续"
            : "需要在这个标签页点一下人工验证，验证后会自动继续";
          await writeBatch(state);
          try {
            await chrome.tabs.update(tab.id, { active: true });
          } catch (err) {
            /* ignore */
          }
          notifyBatch("第 " + (index + 1) + " 篇需要人工操作，已切到该标签页");
        }
        continue;
      }
      if (challenged) {
        challenged = false;
        item.status = "working";
        item.detail = "";
        await writeBatch(state);
      }

      lastInfo = info;
      const candidate = pickPdfUrl(info, base);
      if (!candidate) {
        if (info.ready === "complete" && !settleDeadline) settleDeadline = Date.now() + 20000;
        if (settleDeadline && Date.now() > settleDeadline) break;
        continue;
      }

      // 验证通过后页面会重新渲染、给出新的 md5，所以每轮都取"没试过"的
      const fresh = pdfVariants(candidate, base).filter((url) => !tried.has(url));
      if (!fresh.length) {
        if (!settleDeadline) settleDeadline = Date.now() + 15000;
        if (Date.now() > settleDeadline) break;
        continue;
      }
      for (const url of fresh) tried.add(url);
      attempts += 1;

      for (const url of fresh) {
        const got = await downloadVerified(url, folder + "/main.pdf", true);
        if (got.ok) {
          download = got;
          pdf = url;
          break;
        }
        download = download && download.ok ? download : got;
      }
      if (download && download.ok) break;

      item.detail =
        "第 " + attempts + " 次尝试没成功（" +
        ((download && download.reason) || "未知") +
        "），继续等页面刷新…";
      await writeBatch(state);
      if (attempts >= 3) break;
    }

    // 直接下载都不行时，最后再试一次"另开标签页导航"，避免占用文章页
    if (!(download && download.ok) && pdf) {
      try {
        const helper = await chrome.tabs.create({ url: "about:blank", active: false });
        const navigated = await downloadViaNavigation(
          helper.id,
          pdf,
          folder,
          "main.pdf",
          60000,
          async () => {
            item.status = "challenge";
            item.detail = "需要在弹出的标签页里点一下确认，之后会自动继续";
            await writeBatch(state);
          }
        );
        try {
          await chrome.tabs.remove(helper.id);
        } catch (err) {
          /* ignore */
        }
        if (navigated && navigated.ok) download = navigated;
        else if (navigated && navigated.manual && !(download && download.ok)) download = navigated;
      } catch (err) {
        /* ignore */
      }
    }

    if (download && download.ok) {
      item.status = "downloaded";
      item.pdf = pdf;
      item.saved = download.name;

      const siUrls = pickSiUrls(lastInfo, base, pdf);
      for (let n = 0; n < siUrls.length && n < 10; n += 1) {
        const got = await downloadVerified(
          siUrls[n],
          folder + "/" + siFilename(siUrls[n], n + 1),
          false
        );
        if (got.ok) item.si.push(got.name);
      }
      item.detail =
        "正文已保存" + (item.si.length ? "，补充材料 " + item.si.length + " 个" : "");
      await writeBatch(state);
    } else if (download && download.manual) {
      item.status = "manual";
      item.detail = download.reason;
    } else {
      const siUrls = pickSiUrls(lastInfo, base, "");
      for (let n = 0; n < siUrls.length && n < 10; n += 1) {
        const got = await downloadVerified(
          siUrls[n],
          folder + "/" + siFilename(siUrls[n], n + 1),
          false
        );
        if (got.ok) item.si.push(got.name);
      }
      const why = (download && download.reason) || "没找到可用的 PDF 链接";
      if (viewerSeen) {
        // 阅读器出现过，说明页面本身是通的，只是我们拿不到字节
        item.status = "manual";
        item.detail =
          "PDF 已在标签页的阅读器里打开，但程序取不到字节（" + why +
          "）。请在阅读器里点下载按钮，存到 " + folder + "/main.pdf";
        if (item.si.length) item.detail += "（补充材料 " + item.si.length + " 个已保存）";
      } else if (challenged) {
        item.status = "failed";
        item.detail = "一直停在验证页，没能进到文章页（验证未完成或没有访问权限）";
      } else if (item.si.length) {
        item.status = "partial";
        item.detail = "正文拿不到（" + why + "），已取回补充材料 " + item.si.length + " 个";
      } else {
        item.status = "failed";
        item.detail = "正文拿不到（" + why + "）";
      }
    }
    await writeBatch(state);

    if (item.status !== "manual") {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (err) {
        /* ignore */
      }
    }
  }

  state.running = false;
  state.finishedAt = Date.now();
  await writeBatch(state);

  const done = state.items.filter((item) => item.status === "downloaded").length;
  notifyBatch("批量完成：" + done + "/" + state.items.length + " 篇已下载");
  return state;
}

/* -------------------------------------------------------------- 消息 */

/* 注入页面执行：用页面自己的 Referer 与会话探测资源类型 */
function probeInPage(url) {
  return fetch(url, { credentials: "include" })
    .then(async (response) => {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      reader.cancel().catch(() => {});
      const bytes = (chunk && chunk.value) || new Uint8Array();
      const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 5)));
      const preview = new TextDecoder()
        .decode(bytes.slice(0, 240))
        .replace(/\s+/g, " ")
        .trim();
      return {
        status: response.status,
        type: (response.headers.get("content-type") || "").toLowerCase(),
        head: head,
        preview: preview,
        size: bytes.length,
      };
    })
    .catch((err) => ({ error: String(err && err.message) }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "batch-run") {
    runBatch(message.dois || [], message.base || "").then(
      (state) => sendResponse({ ok: true, state }),
      (err) => sendResponse({ ok: false, error: String(err && err.message) })
    );
    return true;
  }
  if (message.type === "diagnose") {
    const urls = (message.urls || []).slice(0, 12);
    const base = message.base || "";
    (async () => {
      const rows = [];
      for (const raw of urls) {
        let url = String(raw).trim();
        if (!url) continue;
        if (base && /^https?:\/\//i.test(url) && !url.startsWith(base)) {
          url = DOIWebVPN.convert(url, base);
        }
        const probe = await probeDocument(url);
        rows.push({
          url: url.slice(0, 160),
          kind: probe.kind,
          contentType: probe.contentType || "",
          reason: probe.reason || "",
        });
      }
        // 同一个 URL，再从页面上下文取一次：这里带 Referer 和页面自己的会话，
        // 能区分「没权限」和「被 Cloudflare 拦自动化」。
        const tabId = message.tabId;
        if (tabId && urls.length) {
          let first = String(urls[0]).trim();
          if (base && /^https?:\/\//i.test(first) && !first.startsWith(base)) {
            first = DOIWebVPN.convert(first, base);
          }
          try {
            const [injected] = await chrome.scripting.executeScript({
              target: { tabId },
              func: probeInPage,
              args: [first],
            });
            const page = injected && injected.result;
            if (page) {
              rows.push({
                url: "[页面上下文] " + first.slice(0, 140),
                kind: page.head === "%PDF-" ? "pdf" : page.type.includes("html") ? "html" : "other",
                contentType: page.type || "",
                reason:
                  "status=" + page.status +
                  " size=" + page.size +
                  (page.head === "%PDF-" ? "" : " 开头: " + (page.preview || page.error || "")),
              });
            }
          } catch (err) {
            rows.push({ url: "[页面上下文] " + first.slice(0, 120), kind: "error", contentType: "", reason: String(err && err.message) });
          }
        }

        sendResponse({ ok: true, rows });
    })();
    return true;
  }

  if (message.type === "batch-state") {
    readBatch().then((state) => sendResponse(state));
    return true;
  }
  if (message.type === "zotero-collections") {
    zoteroCollections().then(
      (info) => sendResponse(info),
      () => sendResponse({ ok: false, targets: [] })
    );
    return true;
  }

  if (message.type === "zotero-ping") {
    zoteroPing().then(
      (info) => sendResponse(info),
      () => sendResponse({ ok: false, version: "" })
    );
    return true;
  }

  if (message.type === "prepare") {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (message.type === "run") {
    const job = message.job || {};
    const record = message.record;

    (async () => {
      if (record) await writeJob(record);
      if (job.dirHandle) {
        await ensureOffscreen();
        // 由 worker 转发：离屏文档会收到，自己不会收到自己的消息
        chrome.runtime.sendMessage({ type: "run", job }).catch(() => {});
      } else {
        runDownloads(job).catch((err) =>
          report({ state: "fail", done: 0, total: 0, error: String(err) })
        );
      }
    })().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (message.type === "progress") {
    // 来自离屏文档（文件夹模式）的进度：落库 + 徽标
    updateBadge(message);
    applyProgress(message);
  }
  return false;
});

// 启动时先把 Zotero 状态探一遍，弹窗打开就有缓存可用
chrome.runtime.onStartup.addListener(() => {
  zoteroPing(1).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  zoteroPing(1).catch(() => {});
});

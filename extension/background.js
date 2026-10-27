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

/**
 * 从标签页地址里取出真正的 PDF 地址。
 *
 * Chrome 内置 PDF 阅读器的 url 常常是
 *   chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=<编码后的地址>
 * 之前用 startsWith("chrome-extension://") 一刀切跳过，等于把最可靠的线索丢了。
 */
/**
 * 判断一个地址是不是"真正的 PDF 文件"。
 *
 * 关键：只看 **路径**，不看查询串。Elsevier 的中间页是
 *   /science/article/pii/XXX/pdfft?md5=...&pid=1-s2.0-XXX-main.pdf
 * 整串以 -main.pdf 结尾，用整串正则会被误判成 PDF，而它实际返回校验页 HTML。
 */
function looksLikeRealPdf(url) {
  const raw = String(url || "");
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return /\.pdf$/i.test(parsed.pathname);
  } catch (err) {
    return /\.pdf(?:[?#]|$)/i.test(raw);
  }
}

function pdfUrlFromTabUrl(url) {
  const raw = String(url || "");
  if (!raw) return "";

  // 情况一：Chrome 内置阅读器，地址是 chrome-extension://...?file=<编码后的 PDF 地址>
  if (/^chrome-extension:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const file = parsed.searchParams.get("file");
      if (file) return file;
    } catch (err) {
      /* ignore */
    }
    const hashMatch = raw.match(/[#&]file=([^&]+)/);
    if (hashMatch) {
      try {
        return decodeURIComponent(hashMatch[1]);
      } catch (err) {
        /* ignore */
      }
    }
    // 兜底：无论地址长什么样，只要整串里嵌着一个 http(s) 的 .pdf 地址就解出来
    try {
      const decoded = decodeURIComponent(raw);
      const inner = decoded.match(/https?:\/\/[^\s"'<>]+?\.pdf(\?[^\s"'<>]*)?/i);
      if (inner && looksLikeRealPdf(inner[0])) return inner[0];
    } catch (err) {
      /* ignore */
    }
    return "";
  }

  // 情况二：标签页地址本身就是 PDF（含 pdf.sciencedirectassets.com 的签名地址）
  if (looksLikeRealPdf(raw)) return raw;

  // 情况三：地址里嵌着 PDF 地址（少见但存在）
  try {
    const decoded = decodeURIComponent(raw);
    const inner = decoded.match(/https?:\/\/[^\s"'<>]+?\.pdf(\?[^\s"'<>]*)?/i);
    if (inner && looksLikeRealPdf(inner[0])) return inner[0];
  } catch (err) {
    /* ignore */
  }
  return "";
}

/* 记录每个标签页最近出现过的 PDF 地址。
 *
 * 为什么需要：Chrome 内置 PDF 阅读器的标签页属于另一个扩展的内部页，
 * 即使有 tabs 权限也可能读不到 tab.url。而网络层一定能看到真实请求，
 * 所以这里兜一层——标签页地址取不到时，用最近一次请求的 PDF 地址。 */
const recentPdfByTab = new Map();
let recentPdfLast = { url: "", at: 0 };

try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url || "";
      // 只认真正以 .pdf 结尾的地址。
      // 注意：不能按 sciencedirectassets.com 域名判断——那个域名同时托管网站的
      // JS/CSS/字体（例如 ai-components.js），曾因此把正文下载成 .js 文件。
      if (looksLikeRealPdf(url)) {
        const at = Date.now();
        recentPdfByTab.set(details.tabId, { url, at });
        recentPdfLast = { url, at };
      }
    },
    { urls: ["<all_urls>"] }
  );
} catch (err) {
  /* webRequest 不可用时静默跳过 */
}

function recentPdfForTab(tabId) {
  const hit = recentPdfByTab.get(tabId);
  if (!hit) return "";
  if (Date.now() - hit.at > 10 * 60 * 1000) return "";
  return hit.url || "";
}

/**
 * 开一个后台标签页去请求指定地址，从网络请求里截下真正的 PDF 地址。
 *
 * 为什么需要：Elsevier 的 View PDF 会把人弹回文章页（?ref=pdf_download），
 * PDF 不会留在标签页里；但网络层一定看得到那次 .pdf 请求（含重定向后的
 * pdf.sciencedirectassets.com 签名地址）。这里就靠 webRequest 截它。
 */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一个新的下载结束（按 startTime 判定），比 grabFreshDownload 更稳。 */
async function waitForNewDownload(startedAt, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 40000);
  while (Date.now() < deadline) {
    await sleepMs(600);
    let items = [];
    try {
      items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 10 });
    } catch (err) {
      items = [];
    }
    const hit = items.find(
      (it) => it && new Date(it.startTime).getTime() >= startedAt - 2000
    );
    if (!hit) continue;
    if (hit.state === "complete") return { ok: true, filename: hit.filename || "" };
    if (hit.state === "interrupted") return { ok: false, filename: hit.filename || "" };
  }
  return { ok: false, filename: "" };
}

/**
 * 在扩展后台把 PDF 取成字节，用 Blob URL 交给下载器。
 *
 * 优势：扩展有 host 权限，fetch 不受跨域限制；Blob 下载不走服务器，
 * 因此不会再被 CDN 的人机校验拦掉。
 */
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 用 CDP 读浏览器自己导航拿到的 PDF 字节。
 *
 * 为什么：Cloudflare 只放行「文档类型」的导航请求，扩展的 fetch / downloads
 * 请求会被 403（1.2MB 拦截页），而且 Sec-Fetch-Dest 这类头扩展改不了。
 * 浏览器导航本身是成功的——那就挂上 debugger，让浏览器去导航，再从
 * Network.getResponseBody 把字节读出来。
 */
/**
 * 用 CDP 的 Fetch 域在「响应阶段」拦一次，直接读响应体。
 *
 * Network.getResponseBody 对内置 PDF 阅读器处理的响应经常拿不到体，
 * 而 Fetch.requestPaused（requestStage: Response）能拿到，读完后放行。
 */
async function capturePdfViaFetchDomain(tabId, url, timeoutMs) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    return { ok: false, error: "attach: " + String((err && err.message) || err).slice(0, 90) };
  }

  const state = { base64: "", error: "", seen: [] };

  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tabId) return;
    if (method !== "Fetch.requestPaused") return;

    const requestId = params.requestId;
    const requestUrl = (params.request && params.request.url) || "";
    const status = params.responseStatusCode || 0;
    if (state.seen.length < 8) {
      state.seen.push({ url: requestUrl.slice(0, 110), status });
    }

    if (status && !state.base64) {
      chrome.debugger
        .sendCommand(target, "Fetch.getResponseBody", { requestId })
        .then((body) => {
          let b64 = "";
          if (body && body.base64Encoded && body.body) b64 = body.body;
          else if (body && body.body) b64 = btoa(body.body);
          if (b64 && b64.startsWith("JVBER")) state.base64 = b64;
        })
        .catch(() => {
          /* ignore */
        })
        .finally(() => {
          chrome.debugger
            .sendCommand(target, "Fetch.continueRequest", { requestId })
            .catch(() => {});
        });
      return;
    }

    // 请求阶段（还没响应）：直接放行
    chrome.debugger.sendCommand(target, "Fetch.continueRequest", { requestId }).catch(() => {});
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand(target, "Fetch.enable", {
      patterns: [
        { urlPattern: "*.pdf*", requestStage: "Response" },
        { urlPattern: "*sciencedirectassets*", requestStage: "Response" },
      ],
    });
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Page.navigate", { url });

    const deadline = Date.now() + (timeoutMs || 45000);
    while (Date.now() < deadline && !state.base64) {
      await sleepMs(600);
    }
    for (let i = 0; i < 14 && !state.base64; i += 1) {
      await sleepMs(500);
    }
  } catch (err) {
    state.error = "navigate: " + String((err && err.message) || err).slice(0, 90);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    try {
      await chrome.debugger.sendCommand(target, "Fetch.disable");
    } catch (err) {
      /* ignore */
    }
    try {
      await chrome.debugger.detach(target);
    } catch (err) {
      /* ignore */
    }
  }

  if (!state.base64) {
    return { ok: false, error: state.error || "没拿到 PDF 响应体", seen: state.seen };
  }
  return { ok: true, base64: state.base64, seen: state.seen };
}

async function capturePdfViaDebugger(tabId, url, timeoutMs) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    return { ok: false, error: "attach: " + String((err && err.message) || err).slice(0, 90) };
  }

  const state = {
    base64: "",
    error: "",
    seen: [],        // 观察到的候选请求（用于追踪）
    tried: new Map(), // requestId -> 已尝试
  };

  const takeBody = (requestId) => {
    if (state.tried.has(requestId) || state.base64) return;
    state.tried.set(requestId, true);
    chrome.debugger
      .sendCommand(target, "Network.getResponseBody", { requestId })
      .then((body) => {
        if (state.base64) return;
        let b64 = "";
        if (body && body.base64Encoded && body.body) b64 = body.body;
        else if (body && body.body) b64 = btoa(body.body);
        if (b64 && b64.startsWith("JVBER")) {
          state.base64 = b64;
        }
      })
      .catch(() => {
        /* 拿不到就算了，继续等其它候选 */
      });
  };

  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tabId) return;

    if (method === "Network.responseReceived") {
      const response = params.response || {};
      const u = response.url || "";
      const mime = (response.mimeType || "").toLowerCase();
      const isCandidate =
        mime.includes("pdf") || looksLikeRealPdf(u) || /sciencedirectassets/i.test(u);
      if (isCandidate && state.seen.length < 8) {
        state.seen.push({ url: u.slice(0, 110), mime: mime.slice(0, 24), id: params.requestId });
      }
      return;
    }

    if (method === "Network.loadingFinished") {
      // 任何候选请求结束都试着取一次体，只认以 %PDF- 开头的
      if (state.seen.some((item) => item.id === params.requestId)) {
        takeBody(params.requestId);
      }
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand(target, "Network.enable");
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Page.navigate", { url });

    const deadline = Date.now() + (timeoutMs || 40000);
    while (Date.now() < deadline && !state.base64) {
      await sleepMs(700);
    }
    for (let i = 0; i < 12 && !state.base64; i += 1) {
      await sleepMs(500);
    }
  } catch (err) {
    state.error = "navigate: " + String((err && err.message) || err).slice(0, 90);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    try {
      await chrome.debugger.detach(target);
    } catch (err) {
      /* ignore */
    }
  }

  if (!state.base64) {
    return {
      ok: false,
      error: state.error || "没拿到 PDF 响应体",
      seen: state.seen,
    };
  }
  return { ok: true, base64: state.base64, seen: state.seen };
}

/** 把 base64 的 PDF 通过 offscreen 生成 Blob URL 再保存。 */
async function saveBase64Pdf(base64, folder, name) {
  const startedAt = Date.now();
  let made = null;
  try {
    await ensureOffscreen();
    made = await chrome.runtime.sendMessage({ type: "blobDownload", base64 });
  } catch (err) {
    return { ok: false, error: "offscreen: " + String((err && err.message) || err).slice(0, 100) };
  }
  if (!made || !made.ok || !made.objectUrl) {
    return { ok: false, error: (made && made.error) || "未生成 Blob 地址" };
  }
  try {
    await startDownload({
      url: made.objectUrl,
      filename: folder + "/" + name,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (err) {
    return { ok: false, error: "下载失败: " + String((err && err.message) || err).slice(0, 100) };
  }
  const done = await waitForNewDownload(startedAt, 90000);
  return { ok: done.ok, file: done.filename.slice(-40) };
}

async function savePdfFromServiceWorker(url, folder, name) {
  const startedAt = Date.now();
  const attempts = [];
  let buffer = null;
  let okResponse = null;

  // 预签名地址本身带授权，不需要 cookie；带 cookie 反而可能被 CDN 当成异常请求。
  // 先不带，再带，两次都记录结果。
  for (const credentials of ["omit", "include"]) {
    let response = null;
    try {
      response = await fetch(url, { credentials });
    } catch (err) {
      attempts.push({ credentials, error: String((err && err.message) || err).slice(0, 90) });
      continue;
    }

    let buf = null;
    try {
      buf = await response.arrayBuffer();
    } catch (err) {
      attempts.push({ credentials, status: response.status, error: "读取响应失败" });
      continue;
    }

    const bytes = new Uint8Array(buf);
    const isPdf =
      bytes.length > 4 &&
      bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

    if (isPdf) {
      buffer = buf;
      okResponse = response;
      attempts.push({ credentials, status: response.status, pdf: true, size: bytes.length });
      break;
    }

    let head = "";
    try {
      head = new TextDecoder().decode(bytes.slice(0, 160)).replace(/\s+/g, " ");
    } catch (err) {
      head = "";
    }
    attempts.push({
      credentials,
      status: response.status,
      type: (response.headers.get("content-type") || "").slice(0, 30),
      size: bytes.length,
      head,
    });
  }

  if (!buffer) {
    return { ok: false, detail: { attempts } };
  }

  let made = null;
  try {
    await ensureOffscreen();
    made = await chrome.runtime.sendMessage({
      type: "blobDownload",
      base64: bytesToBase64(new Uint8Array(buffer)),
    });
  } catch (err) {
    return {
      ok: false,
      detail: { attempts, error: "offscreen 生成 Blob 失败: " + String((err && err.message) || err).slice(0, 100) },
    };
  }

  if (!made || !made.ok || !made.objectUrl) {
    return { ok: false, detail: { attempts, error: (made && made.error) || "未生成 Blob 地址" } };
  }

  try {
    await startDownload({
      url: made.objectUrl,
      filename: folder + "/" + name,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (err) {
    return {
      ok: false,
      detail: { attempts, error: "Blob 下载失败: " + String((err && err.message) || err).slice(0, 100) },
    };
  }

  const result = await waitForNewDownload(startedAt, 60000);
  return {
    ok: result.ok,
    detail: {
      attempts,
      status: okResponse ? okResponse.status : 0,
      size: new Uint8Array(buffer).length,
      file: result.filename.slice(-40),
    },
  };
}

async function savePdfViaBlob(tabId, url, folder, name) {
  nameHint = { folder, name };
  let result = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: fetchPdfAsBlob,
      args: [url, name],
    });
    result = (res && res.result) || null;
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err).slice(0, 120) };
  }

  if (!result || !result.ok) {
    nameHint = null;
    return { ok: false, detail: result || {} };
  }

  const startedAt = Date.now();
  const got = await waitForNewDownload(startedAt - 30000, 30000);
  nameHint = null;
  return { ok: !!got.ok, detail: result, download: got };
}

async function capturePdfViaNavigation(url, timeoutMs, active) {
  const start = Date.now();
  let tabId = -1;
  try {
    const tab = await chrome.tabs.create({ url, active: !!active });
    tabId = tab && tab.id >= 0 ? tab.id : -1;
  } catch (err) {
    return "";
  }

  const deadline = start + (timeoutMs || 25000);
  let found = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const perTab = tabId >= 0 ? recentPdfForTab(tabId) : "";
    if (perTab) {
      found = perTab;
      break;
    }
    if (recentPdfLast.at > start && recentPdfLast.url) {
      found = recentPdfLast.url;
      break;
    }
  }

  if (tabId >= 0) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (err) {
      /* ignore */
    }
  }
  return found;
}

/**
 * 在页面里把 PDF 取成字节，再用 Blob 触发一次本地下保存。
 *
 * 为什么：预签名地址对"浏览器导航"放行，对扩展的 downloads 请求会返回 HTML
 * （没有 Referer、Sec-Fetch-Dest 也不同）。而在页面上下文里 fetch 拿到字节后，
 * Blob 下载完全不走服务器，任何校验都拦不到。
 *
 * 注入执行，必须自包含。
 */
async function fetchPdfAsBlob(url, fileName) {
  try {
    const response = await fetch(url, { credentials: "include" });
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isPdf =
      bytes.length > 4 &&
      bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

    if (!isPdf) {
      let head = "";
      try {
        head = new TextDecoder().decode(bytes.slice(0, 240)).replace(/\s+/g, " ");
      } catch (err) {
        head = "";
      }
      return {
        ok: false,
        status: response.status,
        type: (response.headers.get("content-type") || "").slice(0, 40),
        size: bytes.length,
        head,
      };
    }

    const blob = new Blob([buffer], { type: "application/pdf" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName || "main.pdf";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        /* ignore */
      }
    }, 120000);

    return { ok: true, status: response.status, size: bytes.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
  }
}

/* 给 Elsevier 的 CDN 请求补上 Referer / Origin。
 *
 * 浏览器点开 PDF 时是导航请求，带 Referer 和完整的 Sec-Fetch 头；扩展发起的
 * fetch / downloads 请求没有这些，CDN 便会回一张校验页 HTML。Referer 可以用
 * declarativeNetRequest 补上，这是扩展唯一能改的那一项。 */
async function installElsevierHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.sciencedirect.com/" },
              { header: "Origin", operation: "set", value: "https://www.sciencedirect.com" },
              { header: "Accept", operation: "set", value: "application/pdf,*/*" },
            ],
          },
          condition: {
            urlFilter: "||pdf.sciencedirectassets.com",
            resourceTypes: [
              "main_frame",
              "sub_frame",
              "xmlhttprequest",
              "other",
              "media",
              "object",
            ],
          },
        },
      ],
    });
  } catch (err) {
    /* 规则装不上就继续，不影响其它路径 */
  }
}

try {
  installElsevierHeaderRule();
} catch (err) {
  /* ignore */
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tab && (tab.url || tab.pendingUrl)) || "";
  } catch (err) {
    return "";
  }
}

async function clickInActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return "";
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: clickPdfLink,
    });
    return (result && result.result) || "";
  } catch (err) {
    return "";
  }
}

async function runDownloads(job) {
  const { tasks, root } = job;
  const total = tasks.length;
  let done = 0;

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    await emit({ index, total, name: task.label, state: "start" });

    // 唯一保留的增强：正文任务若当前标签页本身就是 PDF（Elsevier 会落到
    // pdf.sciencedirectassets.com 的签名地址），优先用那个地址。
    // 其余一律恢复成最朴素的行为：直接下载 → 等完成 → 报结果。
    let target = task.url;
    if (index === 0) {
      const viewerPdf = pdfUrlFromTabUrl(await activeTabUrl());
      if (viewerPdf) target = viewerPdf;
    }

    // Elsevier：只走「预签名地址」这一条确定可行的路。
    //
    // 实测结论：无论 downloads API、页面 fetch、还是照 Zotero 去请求中间页的
    // 跳转目标，都会被 Elsevier 的 CRA 拦回校验页；而浏览器自己点开 PDF 后，
    // 标签页地址栏里是 pdf.sciencedirectassets.com 的预签名链接
    // （?X-Amz-Signature=...），这种地址自带授权，不需要 cookie、不需要过
    // 校验，直接下载就是 PDF。
    //
    // 所以：标签页已经是 PDF 就用它；不是就先让用户点开 PDF，别去撞校验。
    const looksElsevier = /sciencedirect\.com|elsevier\.com/i.test(task.url || "");
    if (index === 0 && looksElsevier) {
      const trace = [];
      const note = (line) => trace.push(line);
      note("任务地址: " + String(task.url).slice(0, 120));
      let activeTab = null;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTab = tab || null;
      } catch (err) {
        activeTab = null;
      }
      note("标签页地址: " + String((activeTab && (activeTab.url || activeTab.pendingUrl)) || "(空)").slice(0, 120));
      let viewerPdf = pdfUrlFromTabUrl((activeTab && (activeTab.url || activeTab.pendingUrl)) || "");
      if (!viewerPdf && activeTab && activeTab.id >= 0) {
        viewerPdf = recentPdfForTab(activeTab.id); // 地址读不到时用网络记录
        note("本标签页网络记录: " + (viewerPdf || "(无)").slice(0, 120));
      }
      if (!viewerPdf && recentPdfLast.at > Date.now() - 5 * 60 * 1000) {
        viewerPdf = recentPdfLast.url; // 最近 5 分钟内任何地方出现过的 PDF
      }
      if (!viewerPdf) {
        await emit({
          index,
          total,
          name: task.label,
          state: "start",
          note: "正在后台请求 PDF，从网络层截取真实地址…",
        });
        // 先后台试（不打扰），不行再用前台标签页（保证 JS 挑战能跑起来）
        viewerPdf = await capturePdfViaNavigation(task.url, 20000, false);
        note("后台截获: " + (viewerPdf || "(无)").slice(0, 120));
        if (!viewerPdf) {
          await emit({
            index,
            total,
            name: task.label,
            state: "start",
            note: "后台没截到，改用前台标签页再试一次…",
          });
          viewerPdf = await capturePdfViaNavigation(task.url, 25000, true);
          note("前台截获: " + (viewerPdf || "(无)").slice(0, 120));
        }
      }
      note("最终采用: " + String(viewerPdf || "(无)").slice(0, 120));
      const persist = async () => {
        try {
          await chrome.storage.local.set({ elsTrace: trace });
        } catch (err) {
          /* ignore */
        }
      };
      await persist();
      if (viewerPdf) {
        // 先试页面内取字节 + Blob 保存（绕开下载请求被拦的问题）
        const tabId = activeTab && activeTab.id >= 0 ? activeTab.id : -1;

        // 方案零：CDP 拦截浏览器自身导航的响应（能绕过 Cloudflare 的请求类型检查）
        if (tabId >= 0) {
          await emit({
            index,
            total,
            name: task.label,
            state: "start",
            note: "用浏览器自身导航取回 PDF…",
          });
          const cdp = await capturePdfViaFetchDomain(tabId, viewerPdf, 45000);
          if (cdp.ok) {
            note("CDP: 成功 " + Math.round((cdp.base64.length * 3) / 4 / 1024) + "KB");
            const saved = await saveBase64Pdf(cdp.base64, root, task.name);
            if (saved.ok) {
              done += 1;
              await emit({ index, total, name: task.label, state: "ok" });
              await persist();
              continue;
            }
            note("CDP 保存失败: " + String(saved.error).slice(0, 100));
          } else {
            note(
              "CDP: " + String(cdp.error).slice(0, 80) +
                " seen=" + JSON.stringify(cdp.seen || []).slice(0, 140)
            );
          }
        }

        // 方案一：后台 fetch + Blob（不受跨域限制，也不走服务器）
        await emit({
          index,
          total,
          name: task.label,
          state: "start",
          note: "在后台取 PDF 字节，用 Blob 保存…",
        });
        const bySw = await savePdfFromServiceWorker(viewerPdf, root, task.name);
        note("后台 Blob: " + JSON.stringify(bySw.detail).slice(0, 160));
        if (bySw.ok) {
          done += 1;
          await emit({ index, total, name: task.label, state: "ok" });
          await persist();
          continue;
        }

        // 方案二：页面内 fetch + Blob
        if (tabId >= 0) {
          await emit({
            index,
            total,
            name: task.label,
            state: "start",
            note: "改用页面内取字节…",
          });
          const byBlob = await savePdfViaBlob(tabId, viewerPdf, root, task.name);
          if (byBlob.ok) {
            done += 1;
            await emit({ index, total, name: task.label, state: "ok" });
            await persist();
            continue;
          }
          note("页面 Blob: " + JSON.stringify(byBlob.detail).slice(0, 160));
          try {
            await chrome.storage.local.set({ elsTrace: trace.concat(["Blob 方式失败: " + JSON.stringify(byBlob.detail).slice(0, 200)]) });
          } catch (err) {
            /* ignore */
          }
        }
        target = viewerPdf;
        await emit({
          index,
          total,
          name: task.label,
          state: "start",
          note: "改用直接下载（Blob 方式未成功）",
        });
      } else {
        let where = "";
        try {
          where = await activeTabUrl();
        } catch (err) {
          where = "";
        }
        await emit({
          index,
          total,
          name: task.label,
          state: "fail",
          error:
            "没取到 PDF 地址；当前标签页 = " +
            (where ? where.slice(0, 110) : "(空)") +
            "。请把这段发我",
        });
        continue;
      }
    }

    // 兜底：target 必须是合法 http(s)，否则回退到原始任务地址
    if (!/^https?:/i.test(target || "")) target = task.url;

    // 中间页（/pdfft、/pdf）不可能是正文本身，下下来只会是校验页
    if (index === 0 && /\/(pdfft|pdf)(\?|$)/i.test(new URL(target, "https://x.invalid").pathname)) {
      await emit({
        index,
        total,
        name: task.label,
        state: "fail",
        error: "只拿到中间页地址（" + String(target).slice(0, 60) + "），没截到真正的 PDF",
      });
      continue;
    }

    // 明显的静态资源一定不是正文，别下
    if (/\.(js|mjs|css|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|map)(\?|$)/i.test(target || "")) {
      await emit({
        index,
        total,
        name: task.label,
        state: "fail",
        error: "地址指向的是网站资源而不是文献文件，已跳过",
      });
      continue;
    }
    if (!/^https?:/i.test(target || "")) {
      await emit({
        index,
        total,
        name: task.label,
        state: "fail",
        error: "页面里没有可用的下载地址（拿到的是 " + String(task.url || "").slice(0, 40) + "）",
      });
      continue;
    }

    try {
      const id = await startDownload({
        url: target,
        filename: root + "/" + task.name,
        saveAs: false,
        conflictAction: "uniquify",
      });
      const state = await waitForDownload(id, 180000);

      // Elsevier 正文若仍落成网页，说明 CRA 校验没过：删掉并说清楚
      if (state === "complete" && index === 0 && looksElsevier) {
        let savedName = "";
        try {
          const found = await chrome.downloads.search({ id });
          savedName = String((found && found[0] && found[0].filename) || "");
        } catch (err) {
          savedName = "";
        }
        note("直下结果: " + savedName.split(/[\\/]/).pop() + " (state=" + state + ")");
        try {
          await chrome.storage.local.set({ elsTrace: trace });
        } catch (err) {
          /* ignore */
        }
        if (/\.html?$/i.test(savedName)) {
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
          await emit({
            index,
            total,
            name: task.label,
            state: "fail",
            error:
              "拿到的是校验页而不是 PDF，已删除；用的地址 = " +
              String(target).slice(0, 130) +
              "｜追踪：" +
              trace.slice(-2).join(" / ").slice(0, 200),
          });
          continue;
        }
      }

      if (state === "complete") {
        done += 1;
        if (index === 0 && looksElsevier) {
          note("直下成功");
          try {
            await chrome.storage.local.set({ elsTrace: trace });
          } catch (err) {
            /* ignore */
          }
        }
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
  // 排序后再取前几个：避免把参考文献里的 PDF 当成正文
  const metaHref = meta ? meta.content : "";
  const doiMeta = document.querySelector('meta[name="citation_doi"]');
  const doiSuffix = doiMeta ? (doiMeta.content || "").split("/").pop() : "";
  const pii = (location.pathname.match(/\/pii\/([A-Za-z0-9]+)/) || [])[1] || "";

  const rank = (href) => {
    let value = 0;
    if (metaHref && href === metaHref) value += 300;
    if (pii && href.indexOf(pii) >= 0) value += 100;
    if (doiSuffix && href.indexOf(doiSuffix) >= 0) value += 80;
    if (href.indexOf(location.hostname) >= 0) value += 50;
    if (/\/pdfft/.test(href)) value += 20;
    return value;
  };

  const sorted = Array.from(new Set(pdfLinks)).sort((a, b) => rank(b) - rank(a));

  return {
    title: document.title,
    ready: document.readyState,
    meta: metaHref,
    links: sorted.slice(0, 5),
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

/**
 * 点击页面里的 PDF 链接，让**浏览器自己**去请求它。
 *
 * 这是关键区别：downloads API / fetch 发出的请求不带 Referer、也不是导航请求，
 * Elsevier 会把它们当成自动化抓取并回一张 403 的 tdm-reservation 页面（就是存成
 * main.html 的那个）。而点击真实链接是导航请求，浏览器带上完整头和会话，服务器
 * 正常返回 PDF —— 用户手点时能下载，正是这个原因。
 *
 * 注入函数必须自包含。
 */
function clickPdfLink() {
  const pii = (location.pathname.match(/\/pii\/([A-Za-z0-9]+)/) || [])[1] || "";
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const pdfish = anchors.filter((a) => /\/pdfft|\/pdf(\?|$)|\.pdf(\?|$)/i.test(a.href));
  if (!pdfish.length) return "";

  const meta = document.querySelector('meta[name="citation_pdf_url"]');
  const metaHref = meta ? meta.content : "";
  const doiMeta = document.querySelector('meta[name="citation_doi"]');
  const doiSuffix = doiMeta ? (doiMeta.content || "").split("/").pop() : "";

  const score = (a) => {
    let value = 0;
    if (metaHref && a.href === metaHref) value += 300;        // 官方声明最可信
    if (pii && a.href.indexOf(pii) >= 0) value += 100;        // 本文优先
    if (doiSuffix && a.href.indexOf(doiSuffix) >= 0) value += 80;
    if (a.hostname === location.hostname) value += 50;        // 同站优先
    else value -= 60;                                          // 外链多为参考文献
    if (/\/pdfft/.test(a.href)) value += 20;
    if (new RegExp("main\\.pdf", "i").test(a.href)) value += 10;
    if (/pdf/i.test(a.textContent || "")) value += 15;
    const section = a.closest("section,li,div");
    if (section && /reference|bibliograph/i.test(section.id || "")) value -= 150;
    return value;
  };

  const best = pdfish.sort((x, y) => score(y) - score(x))[0];
  if (!best) return "";

  const href = best.href;
  try {
    best.setAttribute("target", "_self");
    best.removeAttribute("download");
    best.click();
  } catch (err) {
    return "";
  }
  return href;
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
    let clickAttempted = false;
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

      // Elsevier 通过 /pdfft 跳到 pdf.sciencedirectassets.com 的预签名地址，
      // 那个地址自带授权，直接下载即可 —— 比任何拼地址的办法都可靠。
      let tabUrl = "";
      try {
        tabUrl = (await chrome.tabs.get(tab.id)).url || "";
      } catch (err) {
        tabUrl = "";
      }
      if (/\.pdf(\?|$)/i.test(tabUrl) && !tried.has(tabUrl)) {
        tried.add(tabUrl);
        item.detail = "检测到标签页里已经是 PDF，直接从该地址下载…";
        await writeBatch(state);
        const got = await downloadVerified(tabUrl, folder + "/main.pdf", true);
        if (got.ok) {
          download = got;
          pdf = tabUrl;
          break;
        }
        download = download && download.ok ? download : got;
      }

      const candidate = pickPdfUrl(info, base);
      if (!candidate) {
        if (info.ready === "complete" && !settleDeadline) settleDeadline = Date.now() + 20000;
        if (settleDeadline && Date.now() > settleDeadline) break;
        continue;
      }

      // 先让浏览器自己去点那个 PDF 链接：它发的才是导航请求
      if (!clickAttempted) {
        clickAttempted = true;
        let clicked = "";
        try {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: clickPdfLink,
          });
          clicked = (res && res.result) || "";
        } catch (err) {
          clicked = "";
        }
        if (clicked) {
          item.detail = "已点击页面里的 PDF 链接，等浏览器发起下载…";
          await writeBatch(state);
          nameHint = { folder, name: "main.pdf" };
          const got = await grabFreshDownload(Date.now(), 8000);
          nameHint = null;
          if (got && got.ok) {
            download = got;
            pdf = clicked;
            break;
          }
        }
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

        // Elsevier：把中间页解析结果也报出来，便于判断卡在哪一步
        if (tabId && urls.length) {
          let first = String(urls[0]).trim();
          if (base && /^https?:\/\//i.test(first) && !first.startsWith(base)) {
            first = DOIWebVPN.convert(first, base);
          }
          if (/sciencedirect|elsevier/i.test(first)) {
            try {
              const report = await deepDiagnoseElsevier(tabId, first);
              rows.push({ url: "[取证]", kind: "report", contentType: "", reason: report });
            } catch (err) {
              rows.push({ url: "[取证]", kind: "error", contentType: "", reason: String(err && err.message) });
            }
            const resolved = await resolveElsevierPdf(tabId, first);
            rows.push({
              url: "[Elsevier 中间页解析]",
              kind: resolved ? "resolved" : "empty",
              contentType: "",
              reason: resolved || "没解析到跳转地址（说明拿到的不是中间页）",
            });
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

// DOI 取件器 · 后台
// 除了路由下载，还负责把任务状态写进 storage.local —— 面板关掉再打开能接着看。

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

/* -------------------------------------------------------------- 消息 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
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

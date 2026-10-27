from pathlib import Path

b = Path("extension/background.js")
s = b.read_text(encoding="utf-8")

deep = '''/**
 * Elsevier 取证：把整条链路的原始结果依次记录下来，只读、不改任何下载行为。
 *
 * 需要在真实浏览器里跑，因为它会创建一个临时标签页做真实导航 —— 只有导航
 * 才能通过 cra_js_challenge，而我们要看的就是导航之后地址变成了什么。
 */
async function deepDiagnoseElsevier(pageTabId, url) {
  const lines = [];
  lines.push("目标地址: " + url.slice(0, 150));

  // 1) 页面上下文 fetch，看原始返回
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: pageTabId, allFrames: true },
      func: elsevierInspectRaw,
      args: [url],
    });
    const info = (probe && probe.result) || {};
    lines.push("① fetch: status=" + (info.status || "?") +
               " type=" + (info.type || "?") + " 长度=" + (info.length || 0));
    lines.push("   开头: " + (info.head || "").slice(0, 180));
    if (info.refresh) lines.push("   meta refresh → " + info.refresh.slice(0, 150));
  } catch (err) {
    lines.push("① fetch 失败: " + String(err && err.message).slice(0, 100));
  }

  // 2) 新建临时标签页做真实导航，记录地址变化
  let helper = null;
  try {
    helper = await chrome.tabs.create({ url, active: false });
    const seen = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let current = "";
      try {
        current = (await chrome.tabs.get(helper.id)).url || "";
      } catch (err) {
        break;
      }
      if (current && seen[seen.length - 1] !== current) {
        seen.push(current);
        if (seen.length >= 5) break;
      }
      if (/\\.pdf(\\?|$)/i.test(pdfUrlFromTabUrl(current))) break;
    }
    lines.push("② 导航后地址变化（共 " + seen.length + " 次）:");
    seen.forEach((u, i) => lines.push("   " + (i + 1) + ". " + u.slice(0, 150)));
    const finalPdf = seen.length ? pdfUrlFromTabUrl(seen[seen.length - 1]) : "";
    lines.push("③ 能否取出 PDF 地址: " + (finalPdf ? finalPdf.slice(0, 150) : "否"));
  } catch (err) {
    lines.push("② 导航失败: " + String(err && err.message).slice(0, 100));
  } finally {
    if (helper && helper.id) {
      try {
        await chrome.tabs.remove(helper.id);
      } catch (err) {
        /* ignore */
      }
    }
  }

  return lines.join("\\n");
}

/* 注入页面：只读取中间页的原始响应，不做任何跳转 */
function elsevierInspectRaw(url) {
  return fetch(url, { credentials: "include", redirect: "follow" })
    .then(async (response) => {
      const text = await response.text();
      const refresh =
        text.match(/http-equiv=["']?refresh["']?[^>]*?content=["']?\\s*\\d+\\s*;\\s*url=([^"'>\\s]+)/i) ||
        text.match(/content=["']?\\s*\\d+\\s*;\\s*url=([^"'>\\s]+)/i);
      return {
        status: response.status,
        type: (response.headers.get("content-type") || "").slice(0, 60),
        length: text.length,
        head: text.replace(/\\s+/g, " ").slice(0, 200),
        refresh: refresh ? refresh[1] : "",
      };
    })
    .catch((err) => ({ error: String(err && err.message) }));
}

'''

anchor = "async function navigateAndCapturePdf(tabId, url, timeoutMs) {"
if anchor not in s:
    raise SystemExit("锚点缺失")
s = s.replace(anchor, deep + anchor, 1)

# 接进诊断接口：Elsevier 时额外跑一次取证
old = '''          if (/sciencedirect|elsevier/i.test(first)) {
            const resolved = await resolveElsevierPdf(tabId, first);'''
new = '''          if (/sciencedirect|elsevier/i.test(first)) {
            try {
              const report = await deepDiagnoseElsevier(tabId, first);
              rows.push({ url: "[取证]", kind: "report", contentType: "", reason: report });
            } catch (err) {
              rows.push({ url: "[取证]", kind: "error", contentType: "", reason: String(err && err.message) });
            }
            const resolved = await resolveElsevierPdf(tabId, first);'''
if old not in s:
    raise SystemExit("诊断接入点未匹配")
s = s.replace(old, new, 1)

b.write_text(s, encoding="utf-8")
print("已加入取证功能（不改下载行为）")
current = b.read_text(encoding="utf-8")
for needle in ("deepDiagnoseElsevier", "elsevierInspectRaw", "导航后地址变化"):
    print(f"  {needle[:22]:<24} {'OK' if needle in current else 'MISSING'}")

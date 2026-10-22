// DOI 取件器 · 离屏文档
// 面板关掉后仍在这里继续下载：用页面登录态取文件，流式写进用户选定的文件夹。

const DOC_MAGIC = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // docx/xlsx/pptx/zip
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // 老式 doc/xls/ppt
  [0x7b, 0x5c, 0x72, 0x74, 0x66], // {\rtf
];

function isDocument(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return DOC_MAGIC.some((magic) => magic.every((byte, index) => bytes[index] === byte));
}

function report(payload) {
  chrome.runtime.sendMessage({ type: "progress", ...payload }).catch(() => {});
}

async function saveViaDirectory(dirHandle, task, index, total) {
  const response = await fetch(task.url, { credentials: "include", redirect: "follow" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  if (!response.body) throw new Error("没有响应内容");

  const fileHandle = await dirHandle.getFileHandle(task.name, { create: true });
  const writable = await fileHandle.createWritable();
  const reader = response.body.getReader();

  let written = 0;
  let validated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;

      if (!validated) {
        if (!isDocument(value)) {
          throw new Error("拿到的不是文件（可能是登录页）");
        }
        validated = true;
      }

      await writable.write(value);
      written += value.length;
      if (written % (512 * 1024) < 65536) {
        report({ index, total, name: task.label, state: "writing", bytes: written });
      }
    }
    await writable.close();
    return written;
  } catch (err) {
    try {
      await writable.abort();
    } catch (ignored) {
      /* already closed */
    }
    try {
      await dirHandle.removeEntry(task.name);
    } catch (ignored) {
      /* nothing written */
    }
    throw err;
  }
}

async function runJob(job) {
  const { tasks, dirHandle } = job;
  const total = tasks.length;
  let done = 0;

  if (!dirHandle) {
    // 离屏文档用不了 chrome.downloads，默认模式由后台 worker 负责
    report({ state: "fail", done: 0, total, error: "缺少目标文件夹，已交给浏览器下载器" });
    return;
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    report({ index, total, name: task.label, state: "start" });

    try {
      const size = await saveViaDirectory(dirHandle, task, index, total);
      report({ index, total, name: task.label, state: "ok", bytes: size });
      done += 1;
    } catch (err) {
      report({ index, total, name: task.label, state: "fail", error: err.message });
    }
  }

  report({
    state: done === total ? "done" : done > 0 ? "partial" : "fail",
    done,
    total,
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "run") {
    runJob(message.job).catch((err) =>
      report({ state: "fail", done: 0, total: 0, error: String(err) })
    );
  }
  return false;
});

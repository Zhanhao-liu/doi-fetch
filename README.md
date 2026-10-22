# doi-fetch

**Give it a DOI, get the article PDF *and* its supplementary information.**

A browser extension (Chrome / Edge, no companion software) plus a Python CLI and desktop window.
It reuses the access you already have in your browser — including campus WebVPN / CARSI — and can file
the paper and its attachments straight into Zotero. Anything a publisher shows a PDF link for, it can
fetch; it never bypasses a paywall. MIT licensed, Windows-first.

> **Install the extension:** grab the zip from [Releases](../../releases/latest), unzip it, then
> `chrome://extensions` → enable Developer mode → *Load unpacked* → pick the unzipped folder.
> Documentation below is in Chinese.

---

给一个 DOI，拿到**全文 PDF** 和**补充材料（SI）**。支持校园网关（WebVPN）授权下载。

## 浏览器扩展：在论文页点一下

**不需要启动任何桌面程序**，扩展自己是完整的。

**安装（一次性，约 30 秒）**

1. 从 [Releases](../../releases/latest) 下载扩展 zip 解压，或直接用本仓库的 `extension` 文件夹
2. 打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选择解压出来的文件夹（或本项目的 `extension` 目录）
5. 把「DOI 取件器」固定到工具栏（拼图图标 → 图钉）

**使用**

在论文详情页点工具栏图标，弹出面板：

```
● 论文标题（两行截断）
  10.1038/s41467-023-44674-1
  [2024] [正文 1 个] [补充材料 3 个]

  保存到
  我的文献 / 2024_Yin_machine-learning…   [选择文件夹…]

  ┌──────────── 开始下载 ────────────┐
  正文 PDF              ✓ 已保存
  补充材料 1            ✓ 已保存
  补充材料 2            1 284 KB
```

点「**选择文件夹…**」会弹出系统的目录选择框（和浏览器自带下载的授权一样），选定后在那个目录里为每篇论文建一个子文件夹。不选就存到默认位置：

```
下载/DOI取件/2024_Yin_machine-learning-…/
   main.pdf
   41467_2023_44674_MOESM1_ESM.pdf
   41467_2023_44674_MOESM3_ESM.xlsx
```

**下载过程可以关掉面板**：真正的写入由扩展的离屏文档完成，面板只是显示进度。工具栏徽标同步显示 `1/4`、`✓`、`!`。

**面板会记住任务。** 不小心点到别处、面板收起来，重新点开还是接着显示进度，不会回到「开始下载」让你重复下。已完成的任务也会列出存了哪几个文件。下载结束时会弹一条系统通知。

> 更新扩展文件后，必须到 `chrome://extensions` 点一下这个扩展的「重新加载」，否则浏览器仍在跑旧的 service worker。

### 存入 Zotero

面板底部有「存入 Zotero」勾选框。检测到 Zotero 在运行时会自动勾上并显示版本号；Zotero 没开就灰掉，不影响本地保存。

**可以选择存到哪个分类。** 勾选框下面是分类下拉框，按 Zotero 的树结构缩进列出所有可写分类。默认「跟随 Zotero 当前选中」，也可以在面板里直接选别的，下载时会自动把条目挪过去。

> 技术上是个小弯：Zotero 的 connector 接口只能往「界面里当前选中的分类」写。真正的切换靠 `/connector/updateSession`——它在 `SaveSession.update()` 里先 `selectByID(target)` 改选中项，再 `_updateItems()` 把**已保存**的条目移动到新分类。所以流程是「先存、再挪」，不是「先选、再存」。

下载完成后自动完成两件事：

1. 建一条文献条目
2. 把正文和补充材料作为附件挂到这条条目上

**元数据用 DOI 去 Crossref 取。** Zotero 的 connector 接口本身不做元数据补全（它固定 `attachmentMode: IGNORE`，要求调用方把字段填全），而 Zotero Connector 的元数据是扩展里跑翻译器得到的。Zotero 自己的「通过标识符添加条目」底层也是查 Crossref，所以这里直接取同一份权威数据——期刊、卷、期、页码、ISSN、完整作者列表都比页面 meta 全。没有 DOI 时才退回页面 meta。

条目存进 **Zotero 当前选中的分类**，和 Zotero Connector 的行为一致。单个附件超过 40 MB 会跳过（避免把 100 MB 的复现包塞进去）。

**检测不到 Zotero 时**：这一行右侧会出现「重试」，点一下重新检测；鼠标悬停能看到具体错误。检测失败不会锁死勾选框，你可以强行勾上再试。

> 实现上是在调 Zotero 的本地 connector 接口（`127.0.0.1:23119`）。两个坑值得记：Zotero 会拒绝一切带 `Origin` 却缺少 `X-Zotero-Connector-API-Version` 头的请求（表现为 `Failed to fetch`）；附件元数据走在 HTTP 头里，只能是 ISO-8859-1，所以中文标题要转成 `\uXXXX` 转义。

**原理**

扩展用**你当前浏览器的登录态**直接取文件——和 Zotero Connector 一个思路，也和你手动点「Download PDF」本质相同。不需要任何本地程序。

用了选文件夹时，走浏览器的 File System Access 接口流式写入；没选文件夹时，走 Chrome 自己的下载器（落到「下载」目录）。

**已知限制**

- Chrome 137 起命令行加载扩展被官方禁用，所以只能按上面手动加载一次（之后一直有效）。
- 单页 SI 最多取 12 个。
- 页面本身看不到 PDF 按钮时（无机构权限），扩展也取不到——它不绕付费墙。
- 选了文件夹但系统拒绝授权时，会自动退回「下载」目录，面板里会提示。

## 双击启动（命令行 / 批量用途）

桌面上已有 **DOI 取件器** 快捷方式（也可直接双击项目里的 `启动取件器.bat`）：

1. 窗口里粘贴 DOI 或 doi.org 链接，回车
2. 点「开始下载」
3. 完成后自动打开文件夹

窗口里能改保存目录、开关 SI 下载、以及「登录网关」（会弹出 Chrome 让你完成统一身份认证）。多个 DOI 用空格或换行隔开可一次下载。

「手工 Cookie」是「登录网关」失败时的兜底，不需要 Playwright：在 Chrome 里登录网关后，F12 → Network → 任一请求 → 复制 `Cookie` 请求头，粘进弹窗保存即可。

快捷方式丢了就重建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1
```

命令行等价用法：

```
doi-fetch fetch 10.1038/s41467-023-44674-1
```

输出：

```
10.1038/s41467-023-44674-1
  Machine-learning-accelerated design of high-performance platinum ...
  PDF: unpaywall:publisher (3170 KB, 10 pages)
  SI: 3 file(s)
  -> ~/doifetch-papers/2024_Yin_machine-learning-accelerated-design-...
```

每个 DOI 落到一个目录，**正文和 SI 平铺在一起**：

```
2024_Yin_machine-learning-.../
  main.pdf                        正文
  41467_2023_44674_MOESM1_ESM.pdf 补充材料（保持原始格式：PDF/DOCX/XLSX/ZIP）
  41467_2023_44674_MOESM2_ESM.pdf
  41467_2023_44674_MOESM3_ESM.xlsx
  metadata.json                   Crossref/DataCite/arXiv 元数据
  report.json                     本次取件的完整诊断（来源、失败原因、耗时）
```

`report.json` 的 `si_assets` 记录了每个 SI 的来源 URL，所以平铺也不会丢失出处。

## 安装

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe -e ".[browser,webvpn]"
```

只想用公开渠道（不装浏览器依赖）：

```powershell
uv pip install --python .venv\Scripts\python.exe -e .
```

`browser` = Playwright（登录校园网关用）；`webvpn` = pycryptodome（网关 URL 改写用）。

## 用法

```powershell
# 单篇 / 多篇
doi-fetch fetch 10.1038/nature12373
doi-fetch fetch 10.1038/xxx 10.1126/yyy --out D:\papers

# 只要正文，不要 SI
doi-fetch fetch 10.1038/xxx --no-si

# 机器可读输出
doi-fetch fetch 10.1038/xxx --json

# 强制只用公开渠道
doi-fetch fetch 10.1038/xxx --auth none
```

## 中科大 WebVPN 配置

USTC 的网关是 `wvpn.ustc.edu.cn`（网瑞达 WEngine），登录一次后所有付费墙论文自动走网关。三条路任选，**后两条不依赖 Playwright**。

**方式一：登录网关（窗口里点「登录网关」）**

```powershell
doi-fetch login --school ustc
```

弹出真实 Chrome，走统一身份认证。注意：会跳到 `id.ustc.edu.cn/cas/login?...`，**那是中科大统一身份认证的正规页面，不是钓鱼站**（页面标题「中国科学技术大学统一身份认证」，正文写着「即将前往『WEBVPN系统』」）。

**方式二：读 Chrome（要求先完全退出 Chrome）**

```powershell
doi-fetch auth from-chrome --school ustc
```

直接解密你 Chrome 里的网关 cookie，完全不碰 SSO。限制：Chrome 运行时 cookie 数据库被独占锁定（Windows 文件锁），必须先退出浏览器；Chrome 若启用了 v20 app-bound 加密则无法离线解密。

**方式三：粘贴 Cookie（最稳，永远可用）**

1. 在 Chrome 里登录 <https://wvpn.ustc.edu.cn>
2. F12 → Network → 任意请求 → 复制 `Cookie` 请求头
3. 执行：

```powershell
doi-fetch auth import-cookie --school ustc
```

**登录一直循环怎么办**

如果输入密码确认后又回到登录页，说明 CAS 把这次登录驳回了。工具会在日志里打印**驳回前那一页的原文**，据此判断是密码、账号风险控制还是二次验证问题。

工具已经去掉了自动化浏览器的识别特征（`navigator.webdriver`、`--enable-automation`、`window.chrome`、语言/插件指纹）——学校 CAS 或 WAF 常据此静默拒绝登录，表现就是密码正确却反复弹回登录页。

判断到底是不是工具的问题：用你日常的 Chrome 打开 <https://wvpn.ustc.edu.cn> 登录一次。

- 日常 Chrome 也循环 → 是账号/权限侧的问题，找学校网络中心
- 日常 Chrome 正常 → 用「粘贴 Cookie」把那次登录态的 cookie 导进来即可

之后验证：

```powershell
doi-fetch auth status          # 会话有效则显示 valid
doi-fetch fetch 10.1016/j.xxxx # 自动走网关
```

Cookie 过期（一般几天到两周）后重跑 `doi-fetch login` 即可。退出登录：`doi-fetch auth logout`。

> 配置和登录态默认存在 `~/.doifetch/`，论文默认存到 `~/doifetch-papers/`。如果这两个位置不可写（受管控的机器），会自动退到 `%LOCALAPPDATA%\doi-fetch` 再到项目下的 `_data/`、`papers/`，不会因为权限问题直接崩掉。

### 登录报 EPERM / mkdtemp 怎么办

```
BrowserType.launch_persistent_context: EPERM: operation not permitted,
mkdtemp 'C:\Users\...\AppData\Local\Temp\playwright-artifacts-XXXXXX'
```

这是 `%TEMP%` 不可写导致的。Playwright 的 Node 驱动调 `mkdtemp` 时**不像 Python 那样有回退**，所以直接失败。工具已经会自动把 `TEMP`/`TMP`/`TMPDIR` 重定向到可写目录（`<配置目录>/tmp`），并在 Chrome → Edge → 内置 Chromium 之间依次尝试。

如果仍然失败（比如被杀软或组策略拦住），点窗口里的「粘贴 Cookie」走另一条路。

### 网关 URL 是怎么改写的

网瑞达（WEngine）把普通 URL 改写为：

```
https://wvpn.ustc.edu.cn/<scheme>[-<port>]/<hex(iv)><hex(AES-CFB(key, iv, hostname))><path>?<query>
```

只有**主机名**被加密，路径保持明文；`iv` 以 hex 形式前置，所以存量网关的 URL 一律以 `77726476706e69737468656265737421` 开头（就是 `wrdvpnisthebest!` 的 ASCII 字节）。实现见 `src/doifetch/auth.py`。

学校清单（145 所）来自 scansci-pdf 的公开数据（Apache-2.0），见 `src/doifetch/data/schools.json`。查学校：

```powershell
doi-fetch schools 北京
doi-fetch schools ustc
```

## 取件策略

按代价从低到高分层，先拿到的赢：

| 层 | 来源 | 是否需要权限 |
|---|---|---|
| 1 | Unpaywall / OpenAlex / Semantic Scholar / Europe PMC / PMC OA / arXiv | 否 |
| 2 | 出版商直链（Wiley pdfdirect、Springer content/pdf、ACS、Science…） | 通常需要 |
| 3 | 落地页解析：`citation_pdf_url` meta + PDF 锚点 | 视情况 |
| 4 | 走 WebVPN 网关重试以上直链与落地页 | 需要校园登录态 |

SI 的发现顺序独立于正文（正文有 OA 版本不代表 SI 也开放）：

1. 落地页的 SI 链接（Springer `MOESM*_ESM`、Elsevier `mmc1`、ACS `suppl_file`、Wiley `downloadSupplement`、PLOS `type=supplementary`、RSC `suppdata`、PNAS `sapp`、Science `_sm`…）
2. Europe PMC 的 SI 归档 / PMC 的 `/bin/` 附件
3. Figshare 镜像（ACS、T&F、SAGE、PLOS 常把 SI 放这里，能绕过 ACS 付费墙）

## 状态码

`report.json` 里的 `pdf_status`：

| 值 | 含义 | 下一步 |
|---|---|---|
| `downloaded` | 成功 | — |
| `needs_auth` | 有付费墙或需要登录 | `doi-fetch login` |
| `blocked` | 出版商直接拒绝（403/CF 拦截） | 换网络或用网关登录态 |
| `not_found` | 各渠道都没有 PDF | 检查 DOI 是否正确 |
| `invalid_pdf` | 拿回来的不是 PDF（常见是 HTML 错误页） | — |

## 已知边界

- **不绕过任何法外渠道**：没有 Sci-Hub / LibGen / Tor。只有公开 OA 和**你自己的**校园授权。
- **SI 也可能需要授权**：出版商对补充材料链接一样会拦。工具先走公开渠道，拿到 HTML 登录页时自动改用网关会话重试；仍然拿不到就丢弃并写进 `report.json`，**不会把登录页存成 .pdf**。
- 正文和 SI 都是**原始格式**；把 SI 合并进正文 PDF、建图表交叉引用链接，是下一步的事，本项目暂不做。
- 加密 PDF 不做处理；扫描版 SI 不做 OCR。
- 出版商改版会导致选择器失效——`report.json` 的 `notes` 会写明哪一层失败，便于定位。

## 开发

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

模块分工：

```
src/doifetch/
  cli.py           命令行入口
  fetch.py         编排：分层竞速、落盘、状态判定
  net.py           HTTP 会话、内容校验、重试
  metadata.py      DOI 归一化、doi.org 跳转、Crossref
  oa.py            OA 定链（Unpaywall/OpenAlex/EuropePMC/PMC/arXiv/S2）
  publishers.py    落地页解析、SI 链接识别、Figshare/PMC 兜底
  auth.py          WebVPN URL 改写 + 登录态持久化
  schools.py       学校注册表
```

## 许可

MIT。`src/doifetch/data/schools.json` 数据来源于 scansci-pdf（Apache-2.0）。

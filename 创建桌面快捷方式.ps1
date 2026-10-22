# Create a Desktop shortcut to the DOI fetcher GUI.
# Usage: powershell -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1

$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $project "启动取件器.bat"

if (-not (Test-Path $target)) {
    throw "launcher not found: $target"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$link = Join-Path $desktop "DOI 取件器.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $project
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,70"
$shortcut.Description = "粘贴 DOI，下载全文 PDF 和补充材料"
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host "Created: $link"

# 弹出 Windows 原生"选择文件夹"对话框，把选中的绝对路径写到 stdout。
# 取消或出错时不输出任何内容，退出码 2。
# 用 IFileOpenDialog + FOS_PICKFOLDERS（见同目录 FolderPicker.cs），
# 与 FISH Dock 宿主 paper.rs:588 是同一个 COM 接口，外观即系统"选择文件夹"。
param(
  [string]$Initial = '',
  [string]$Title  = '选择文件夹'
)

# 关键：PowerShell 默认按控制台代码页（中文系统是 GBK/936）往 stdout 写字节，
# 而 Node 端按 UTF-8 解码 —— 中文路径会整段变成乱码，导致选完的文件夹既存不进
# 根目录列表（fs.statSync 失败被过滤），也打不开（tree 报「不在允许的根目录内」）。
# 所以必须在输出前把 Console 的输出编码钉成无 BOM 的 UTF-8。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

try {
  if (-not ('FishDockPick.FolderPicker' -as [type])) {
    . (Join-Path $here 'FolderPicker.ps1')
    Add-Type -TypeDefinition $FolderPickerSource -Language CSharp
  }
  if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    [Threading.Thread]::CurrentThread.SetApartmentState('STA')
  }
  $picked = [FishDockPick.FolderPicker]::Pick($Initial, $Title)
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 2
}

if ([string]::IsNullOrWhiteSpace($picked)) { exit 2 }
[Console]::Out.Write($picked)
exit 0

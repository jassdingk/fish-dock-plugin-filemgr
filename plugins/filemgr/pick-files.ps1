# 弹出 Windows 原生"选择文件"多选对话框，把选中的绝对路径（每行一个）写到 stdout。
# 取消或出错时不输出任何内容，退出码 2。
# 使用 FolderPicker.cs 的 IFileOpenDialog + FOS_ALLOWMULTISELECT，
# 与 pick-folder.ps1 一致（同一套 COM 代码，已验证能弹窗在前台）。
param(
  [string]$Path   = '',
  [string]$Title  = '选择文件'
)

# 关键：同 pick-folder.ps1，中文路径必须用 UTF-8 输出
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
  $picked = [FishDockPick.FolderPicker]::PickFiles($Path, $Title)
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 2
}

if ($null -eq $picked -or $picked.Count -eq 0) { exit 2 }
foreach ($p in $picked) {
  [Console]::Out.WriteLine($p)
}
exit 0
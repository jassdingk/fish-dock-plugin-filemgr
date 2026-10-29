# 把命令行参数列出的文件路径设入剪贴板 FileDrop 列表。
# 用法：powershell -File clip.ps1 <file1> [file2 ...]
# 无参数时清空 FileDrop 列表。

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

# 关键：同 pick-folder.ps1，中文路径必须用 UTF-8 输出
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'

try {
  if ($Paths.Count -eq 0) {
    Set-Clipboard -Path $null
    exit 0
  }

  $valid = @()
  foreach ($p in $Paths) {
    if (Test-Path -LiteralPath $p) {
      $valid += (Resolve-Path -LiteralPath $p).Path
    } else {
      [Console]::Error.WriteLine("clip.ps1: not found — $p")
    }
  }

  if ($valid.Count -gt 0) {
    Set-Clipboard -Path $valid
  } else {
    # 清空而非报错，让调用方始终能继续
    Set-Clipboard -Path $null
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
exit 0
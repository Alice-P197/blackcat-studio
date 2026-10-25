# 给打包产物补图标与版本信息
#
# 为什么需要这个脚本：
#   electron-builder.yml 里设了 `signAndEditExecutable: false`。因为 app-builder 的 rcedit
#   即使在 Windows 上也会去下载 winCodeSign，而该压缩包内含 macOS 的
#   darwin/10.12/lib/libcrypto.dylib、libssl.dylib 符号链接；本机不是管理员、也没开
#   Windows 开发者模式，7za 建符号链接失败 → "Cannot create symbolic link" → 打包直接退出 1。
#   关掉之后 electron-builder 不再调用 rcedit/签名，图标和版本信息就在这里手动补。
#
# rcedit 来源：从 winCodeSign 缓存压缩包里只取 rcedit-x64.exe（用 7za -snl- 不解符号链接）：
#   node_modules\7zip-bin\win\x64\7za.exe e <winCodeSign>.7z -o tools -snl- -y "-ir!*rcedit-x64.exe"
[CmdletBinding()]
param(
    [string[]]$Targets,
    [string]$Rcedit = (Join-Path $PSScriptRoot 'tools\rcedit-x64.exe'),
    [string]$Icon = (Join-Path $PSScriptRoot 'dist\.icon-ico\icon.ico')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Rcedit)) { throw "找不到 rcedit: $Rcedit" }
if (-not (Test-Path $Icon)) { throw "找不到图标 ico: $Icon" }

if (-not $Targets -or $Targets.Count -eq 0) {
    $Targets = @()
    $inner = Join-Path $PSScriptRoot 'dist\win-unpacked\小黑喵创作台.exe'
    if (Test-Path $inner) { $Targets += $inner }
    $Targets += (Get-ChildItem (Join-Path $PSScriptRoot 'dist') -Filter '*.exe' -File | Select-Object -ExpandProperty FullName)
}

$product = '小黑喵创作台'
$desc = '小黑喵创作台 V3 · Notion ↔ 创作台 ↔ 微信公众号 一体化排版工作台'

foreach ($t in $Targets) {
    if (-not (Test-Path $t)) { Write-Warning "跳过（不存在）: $t"; continue }
    Write-Host ("=== 打标: " + (Split-Path $t -Leaf))

    # ⚠️ 防呆：NSIS 产物（便携版/安装包）的数据是追加在 PE 尾部的 overlay，rcedit 会把它整段丢掉
    # （实测 71.81 MB → 0.09 MB）。所以先备份、比对大小，缩水超过 1% 就还原并报错。
    $sizeBefore = (Get-Item $t).Length
    $backup = "$t.rcedit-bak"
    Copy-Item $t $backup -Force

    & $Rcedit $t `
        --set-icon $Icon `
        --set-version-string ProductName $product `
        --set-version-string FileDescription $desc `
        --set-version-string CompanyName 'Alice-P197' `
        --set-version-string LegalCopyright 'Copyright © 2026 Alice-P197' `
        --set-version-string InternalName $product `
        --set-file-version '3.0.0.0' `
        --set-product-version '3.0.0' | Out-Null
    $rc = $LASTEXITCODE

    $sizeAfter = (Get-Item $t).Length
    if ($sizeAfter -lt $sizeBefore * 0.99) {
        Copy-Item $backup $t -Force
        Remove-Item $backup -Force
        throw ("rcedit 把文件改小了（{0:N0} → {1:N0} 字节），已还原。该文件很可能带 NSIS overlay，不能打标: {2}" -f $sizeBefore, $sizeAfter, $t)
    }
    Remove-Item $backup -Force
    if ($rc -ne 0) { throw "rcedit 失败 (exit $rc): $t" }

    $vi = (Get-Item $t).VersionInfo
    Write-Host ("    ProductName   = " + $vi.ProductName)
    Write-Host ("    FileVersion   = " + $vi.FileVersion)
    Write-Host ("    CompanyName   = " + $vi.CompanyName)
    Write-Host ("    Size(MB)      = " + [math]::Round($sizeAfter / 1MB, 2))
}
Write-Host '完成。'

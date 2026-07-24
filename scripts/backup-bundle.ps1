$src  = Join-Path $PSScriptRoot "..\public\vendor"
$date = Get-Date -Format "yyyy-MM-dd"
$dest = Join-Path $env:USERPROFILE "OneDrive\백업\gantt-vendor\$date"

Write-Host "백업 시작: $src → $dest"

New-Item -ItemType Directory -Force $dest | Out-Null
$files = Get-ChildItem -Path $src -Recurse -File
foreach ($f in $files) {
    $rel  = $f.FullName.Substring($src.Length).TrimStart('\','/')
    $out  = Join-Path $dest $rel
    New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
    Copy-Item $f.FullName $out -Force
    Write-Host "  복사됨: $rel"
}

Write-Host ""
Write-Host "백업 완료 — 총 $($files.Count)개 파일 → $dest"

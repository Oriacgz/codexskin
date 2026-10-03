param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Thumbprint,
  [Parameter(Mandatory=$true)][string]$TimestampUrl,
  [string]$SignTool='signtool.exe'
)
$ErrorActionPreference='Stop'
if ($Thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Expected certificate SHA-1 thumbprint' }
$timestamp=[Uri]$TimestampUrl
if (-not $timestamp.IsAbsoluteUri -or $timestamp.Scheme -ne 'https' -or $timestamp.UserInfo) { throw 'Timestamp URL must use HTTPS without credentials' }
$store=New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser')
try {
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
  $certificate=$store.Certificates | Where-Object { $_.Thumbprint -eq $Thumbprint }
} finally { $store.Close() }
if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'No usable code-signing certificate in CurrentUser/My' }
$usage=$certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
if (-not $usage -or -not ($usage.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) { throw 'Certificate does not permit code signing' }
$target=(Resolve-Path -LiteralPath $Executable).Path
if ($SignTool -eq 'signtool.exe' -and -not (Get-Command $SignTool -ErrorAction SilentlyContinue)) {
  $sdkRoot=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $candidate=Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $candidate) { throw 'Windows SDK SignTool not found; set CODEXSKIN_SIGNTOOL' }
  $SignTool=$candidate
}
& $SignTool sign /sha1 $Thumbprint /s My /fd SHA256 /tr $TimestampUrl /td SHA256 $target
if ($LASTEXITCODE -ne 0) { throw 'SignTool signing failed' }
& $SignTool verify /pa /all /v $target
if ($LASTEXITCODE -ne 0) { throw 'SignTool verification failed' }
$signature=Get-AuthenticodeSignature -LiteralPath $target
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $Thumbprint -or -not $signature.TimeStamperCertificate) { throw 'Final signature or trusted timestamp verification failed' }
Write-Output 'Verified signed and timestamped executable'

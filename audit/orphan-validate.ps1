Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
Where-Object { $_.CommandLine -match 'codexskin-tray\.ps1' } |
ForEach-Object {
  $trayPid = $_.ProcessId; $line = $_.CommandLine; $alive = $false
  if ($line -match '-Port\s+(\d+)' ) { $trayPort = $Matches[1] } else { $trayPort = $null }
  if ($line -match '-Token\s+([a-zA-Z0-9_-]+)' ) { $trayToken = $Matches[1] } else { $trayToken = $null }
  if ($trayPort -and $trayToken) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $trayPort + '/t/' + $trayToken + '/ping') -TimeoutSec 2; $alive = $response.StatusCode -eq 200 } catch {} }
  if (-not $alive) { Stop-Process -Id $trayPid -Force -ErrorAction SilentlyContinue; $trayPid }
}
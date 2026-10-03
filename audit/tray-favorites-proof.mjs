import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildTrayHostPs1} from '../src/core/tray.js';
if(process.platform!=='win32')throw new Error('Native Windows tray proof requires Windows');
const source=buildTrayHostPs1(),block=source.slice(source.indexOf('  $favorites ='),source.indexOf('  $status ='));
const script="$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Windows.Forms\n$notify=[System.Windows.Forms.NotifyIcon]::new()\n$menu=[System.Windows.Forms.ContextMenuStrip]::new()\nfunction Invoke-RestMethod { return @{themes=@(@{id='one';name='One';favorite=$true;active=$true;broken=$false},@{id='two';name='Two';favorite=$false})} }\nfunction Invoke-Api($route,$body) { $script:clicked=$route; return @{ok=$true} }\nfunction Show-Balloon($message,$kind) {}\n"+block+"\n$method=[System.Windows.Forms.ContextMenuStrip].GetMethod('OnOpening',[System.Reflection.BindingFlags]'Instance,NonPublic')\n$null=$method.Invoke($menu,@([System.ComponentModel.CancelEventArgs]::new()))\nif($favorites.DropDownItems.Count -ne 1 -or -not $favorites.DropDownItems[0].Checked){throw 'Favorite menu incorrect'}\n$favorites.DropDownItems[0].PerformClick()\nif($script:clicked -ne 'apply/one'){throw ('Favorite action incorrect: '+$script:clicked)}\n$menu.Dispose();$notify.Dispose()\nWrite-Output 'PASS native favorite menu and click'\n";
const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000});
process.stdout.write(stdout);

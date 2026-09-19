param(
  [ValidateSet('list', 'screen', 'window')][string]$Mode = 'screen',
  [string]$Match = '',
  [string]$Out = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DSBWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# Перечисляем окна через Get-Process: без колбэков и лишних P/Invoke.
function Get-Windows {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
    Select-Object @{n = 'id'; e = { $_.Id } },
                  @{n = 'process'; e = { $_.ProcessName } },
                  @{n = 'title'; e = { $_.MainWindowTitle } },
                  @{n = 'handle'; e = { $_.MainWindowHandle.ToInt64() } }
}

if ($Mode -eq 'list') {
  $list = @(Get-Windows)
  ConvertTo-Json -InputObject $list -Compress -Depth 4
  exit 0
}

$L = 0; $T = 0; $W = 0; $H = 0

if ($Mode -eq 'window') {
  if (-not $Match) { [Console]::Error.WriteLine('Match required'); exit 2 }
  $hit = Get-Windows | Where-Object { $_.title -like "*$Match*" -or $_.process -like "*$Match*" } | Select-Object -First 1
  if (-not $hit) { [Console]::Error.WriteLine("window not found: $Match"); exit 3 }
  $r = New-Object 'DSBWin+RECT'
  [void][DSBWin]::GetWindowRect([IntPtr]$hit.handle, [ref]$r)
  $L = $r.Left; $T = $r.Top; $W = $r.Right - $r.Left; $H = $r.Bottom - $r.Top
} else {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $L = $vs.Left; $T = $vs.Top; $W = $vs.Width; $H = $vs.Height
}

if ($W -le 0 -or $H -le 0) { [Console]::Error.WriteLine('bad rect'); exit 4 }
if (-not $Out) { [Console]::Error.WriteLine('Out required'); exit 5 }

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($L, $T, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output $Out

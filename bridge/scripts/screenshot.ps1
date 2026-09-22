param(
  [ValidateSet('list', 'screen', 'window')][string]$Mode = 'screen',
  [string]$Match = '',
  [string]$Process = '',
  [long]$Handle = 0,
  [switch]$Foreground,
  [string]$Out = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DSBWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# Перечисляем окна через Get-Process: без колбэков и лишних P/Invoke.
# handle — HWND: его можно вернуть в list_windows и потом снимать окно по нему
# точно, а не угадывая заголовок.
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
  $cand = @(Get-Windows)

  if ($Handle -gt 0) {
    # Самый точный путь: HWND из list_windows. Никаких угадываний.
    $cand = @($cand | Where-Object { $_.handle -eq $Handle })
  } else {
    if (-not $Process -and -not $Match) {
      [Console]::Error.WriteLine('Match, Process or Handle required'); exit 2
    }
    # Фильтры складываются: Process сужает до нужного приложения, Match — до окна.
    # Сравнение через ToLower().Contains — подстрока без учёта регистра, без
    # подстановочных знаков -like (там * и ? в заголовке ломали поиск).
    if ($Process) {
      $p = $Process.ToLower()
      $cand = @($cand | Where-Object { $_.process.ToLower().Contains($p) })
    }
    if ($Match) {
      $m = $Match.ToLower()
      $cand = @($cand | Where-Object { $_.title.ToLower().Contains($m) })
    }
  }

  $hit = $cand | Select-Object -First 1
  if (-not $hit) { [Console]::Error.WriteLine("window not found"); exit 3 }

  $hwnd = [IntPtr]$hit.handle

  # Окно может быть свёрнуто или перекрыто другим — тогда CopyFromScreen снимает
  # чужое. Поднимаем его на передний план. SetForegroundWindow может отказать
  # (Windows не всегда даёт менять фокус), поэтому это не критично.
  if ($Foreground) {
    if ([DSBWin]::IsIconic($hwnd)) { [void][DSBWin]::ShowWindow($hwnd, 9) }
    [void][DSBWin]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
  }

  $r = New-Object 'DSBWin+RECT'
  [void][DSBWin]::GetWindowRect($hwnd, [ref]$r)
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

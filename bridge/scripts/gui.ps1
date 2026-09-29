param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('state', 'focus', 'click', 'type', 'key', 'scroll', 'drag', 'move', 'read', 'set_value', 'clipboard-get', 'clipboard-set')]
  [string]$Action,
  [long]$Handle = 0,
  [string]$Match = '',
  [string]$Process = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$ToX = 0,
  [int]$ToY = 0,
  [string]$Button = 'left',
  [int]$Count = 1,
  [string]$Text = '',
  [string]$Keys = '',
  [int]$Delta = 0,
  [int]$DurationMs = 0,
  [ValidateSet('background', 'foreground')][string]$Mode = 'foreground',
  [switch]$Force
)

# Управление чужими окнами: клики, ввод текста, горячие клавиши, скролл.
#
# Два режима доставки:
#   foreground — SendInput: события идут в системную очередь ввода, рядом с
#     настоящими. Работает везде, но двигает РЕАЛЬНЫЙ курсор и забирает фокус.
#     Твоя мышь в этот момент продолжает работать — её никто не блокирует.
#   background — PostMessage прямо в окно по HWND: курсор не двигается, фокус
#     не воруется, ты работаешь параллельно. Но не все программы принимают
#     такие сообщения (некоторые проверяют, что окно активно). Если не сработало
#     — переключайся на foreground.
#
# Все координаты — в экранных пикселях, начало координат — левый верхний угол
# основного монитора (как в screenshot). В background-режиме координаты
# пересчитываются в клиентские координаты окна.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class DSBGui {
  // --- окна ---
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr childAfter, string className, string windowTitle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

  public const uint WM_GETTEXT = 0x000D;
  public const uint WM_GETTEXTLENGTH = 0x000E;

  // Семантические сообщения Edit-контрола. Работают в background и не требуют
  // состояния модификаторов — в отличие от ctrl+a, который через PostMessage
  // не собирается (проверено на блокноте).
  public const uint EM_SETSEL = 0x00B1;      // выделить диапазон: wParam=начало, lParam=конец (-1 = до конца)
  public const uint EM_REPLACESEL = 0x00C2;  // заменить выделение текстом
  public const uint EM_SCROLLCARET = 0x00B7;

  // Заменить всё содержимое Edit-контрола. Возвращает true, если контрол принял.
  public static bool SetControlText(IntPtr hWnd, string text) {
    // Выделяем всё: EM_SETSEL(0, -1). lParam = -1 как IntPtr.
    SendMessage(hWnd, EM_SETSEL, IntPtr.Zero, (IntPtr)(-1));
    // Заменяем выделение. EM_REPLACESEL принимает указатель на строку.
    IntPtr buf = Marshal.StringToHGlobalUni(text);
    try {
      SendMessage(hWnd, EM_REPLACESEL, (IntPtr)1, buf);
    } finally {
      Marshal.FreeHGlobal(buf);
    }
    return true;
  }

  // Обход ограничения SetForegroundWindow: Windows не даёт чужому процессу
  // украсть фокус, если он сам не в фокусе. Присоединяем свой поток к потоку
  // активного окна, поднимаем нужное, и отсоединяемся. Классический приём.
  public static bool ForceForeground(IntPtr hWnd) {
    IntPtr fg = GetForegroundWindow();
    if (fg == hWnd) return true;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint curThread = GetCurrentThreadId();
    bool attached = false;
    try {
      if (fgThread != curThread) attached = AttachThreadInput(curThread, fgThread, true);
      if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
      BringWindowToTop(hWnd);
      ShowWindow(hWnd, 5);
      SetForegroundWindow(hWnd);
      SetFocus(hWnd);
      Thread.Sleep(80);
      return GetForegroundWindow() == hWnd;
    } finally {
      if (attached) AttachThreadInput(curThread, fgThread, false);
    }
  }

  // Чтение заголовка окна.
  public static string WindowTitle(IntPtr hWnd) {
    int len = GetWindowTextLengthW(hWnd);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 2);
    GetWindowTextW(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // Чтение текста контрола через WM_GETTEXT. Работает для классических
  // Win32-контролов (Edit в блокноте, поля ввода старых программ). Для
  // современных (WPF, Electron, Qt) вернёт пусто — там нужен UI Automation,
  // он появится отдельным действием.
  public static string ControlText(IntPtr hWnd) {
    int len = (int)(long)SendMessage(hWnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 2);
    SendMessageW(hWnd, WM_GETTEXT, (IntPtr)sb.Capacity, sb);
    return sb.ToString();
  }

  // Все дочерние окна первого уровня.
  public static IntPtr[] ChildWindows(IntPtr parent) {
    System.Collections.Generic.List<IntPtr> list = new System.Collections.Generic.List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr p) { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }

  public static string ClassName(IntPtr hWnd) {
    StringBuilder sb = new StringBuilder(256);
    GetClassNameW(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  // --- ввод ---
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  // Константы ввода
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  // WM_* для background-режима (PostMessage)
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_RBUTTONDOWN = 0x0204;
  public const uint WM_RBUTTONUP = 0x0205;
  public const uint WM_MBUTTONDOWN = 0x0207;
  public const uint WM_MBUTTONUP = 0x0208;
  public const uint WM_MOUSEWHEEL = 0x020A;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_SETCURSOR = 0x0020;

  public static int MakeLParam(int x, int y) { return (y << 16) | (x & 0xFFFF); }

  // Нажатие и отпускание в background: PostMessage в окно.
  public static void PostClick(IntPtr hWnd, int clientX, int clientY, uint downMsg, uint upMsg) {
    IntPtr lp = (IntPtr)MakeLParam(clientX, clientY);
    PostMessage(hWnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
    PostMessage(hWnd, downMsg, (IntPtr)1, lp);
    PostMessage(hWnd, upMsg, IntPtr.Zero, lp);
  }

  // Ввод одной Unicode-строки в окно через WM_CHAR — без очереди ввода.
  //
  // Перевод строки для Edit-контрола — это WM_CHAR с '\r' (0x0D), а НЕ
  // WM_KEYDOWN VK_RETURN. Проверено на блокноте: WM_KEYDOWN давал склейку
  // строк в одну, WM_CHAR с '\r' переносит корректно. '\r\n' шлём как один
  // '\r': иначе в поле появились бы две пустые строки.
  public static void PostText(IntPtr hWnd, string text) {
    for (int i = 0; i < text.Length; i++) {
      char ch = text[i];
      if (ch == '\r') {
        PostMessage(hWnd, WM_CHAR, (IntPtr)0x0D, IntPtr.Zero);
        if (i + 1 < text.Length && text[i + 1] == '\n') i++;
      } else if (ch == '\n') {
        PostMessage(hWnd, WM_CHAR, (IntPtr)0x0D, IntPtr.Zero);
      } else {
        PostMessage(hWnd, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
      }
    }
  }

  // Ищем дочерний контрол по классу (Edit, RichEdit, Scintilla и т.п.).
  // Нужно потому, что WM_CHAR, посланный в главное окно, до текстового поля
  // не доходит: в Win32 поле — отдельный дочерний контрол со своим HWND.
  // Блокнот: главное окно "Notepad" -> child "Edit".
  public static IntPtr FindChildByClass(IntPtr parent, string className) {
    return FindWindowExW(parent, IntPtr.Zero, className, null);
  }

  // Первый дочерний контрол, чей класс начинается с одного из перечисленных.
  // Порядок важен: Edit — классика, RichEdit/Scintilla — современные редакторы.
  public static IntPtr FindEditorChild(IntPtr parent) {
    string[] wanted = new string[] { "Edit", "RichEdit", "RICHEDIT", "Scintilla" };
    IntPtr[] kids = ChildWindows(parent);
    foreach (string w in wanted) {
      foreach (IntPtr k in kids) {
        string cls = ClassName(k);
        if (cls == w || cls.StartsWith(w)) return k;
      }
    }
    return IntPtr.Zero;
  }

  // Движение курсора + клик через SendInput. Возвращает число доставленных событий.
  public static uint SendMouseClick(int x, int y, uint downFlag, uint upFlag) {
    SetCursorPos(x, y);
    Thread.Sleep(20);
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = downFlag;
    inputs[1].type = INPUT_MOUSE; inputs[1].u.mi.dwFlags = upFlag;
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void SendMouseMove(int x, int y) { SetCursorPos(x, y); }

  public static void SendScroll(int x, int y, int delta) {
    SetCursorPos(x, y);
    Thread.Sleep(20);
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, UIntPtr.Zero);
  }

  // Unicode-символ через SendInput: работает в любом приложении и не зависит
  // от текущей раскладки клавиатуры (важно для кириллицы).
  public static uint SendUnicodeText(string text) {
    INPUT[] inputs = new INPUT[text.Length * 2];
    int i = 0;
    foreach (char ch in text) {
      inputs[i].type = INPUT_KEYBOARD; inputs[i].u.ki.wVk = 0; inputs[i].u.ki.wScan = ch; inputs[i].u.ki.dwFlags = KEYEVENTF_UNICODE;
      i++;
      inputs[i].type = INPUT_KEYBOARD; inputs[i].u.ki.wVk = 0; inputs[i].u.ki.wScan = ch; inputs[i].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      i++;
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  // Виртуальная клавиша по коду. keybd_event проще SendInput для комбинаций.
  public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero); }
}
"@

# ---------- окна ----------

function Get-Windows {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
    Select-Object @{n = 'id'; e = { $_.Id } },
                  @{n = 'process'; e = { $_.ProcessName } },
                  @{n = 'title'; e = { $_.MainWindowTitle } },
                  @{n = 'handle'; e = { $_.MainWindowHandle.ToInt64() } }
}

function Resolve-Window {
  $cand = @(Get-Windows)
  if ($Handle -gt 0) {
    $cand = @($cand | Where-Object { $_.handle -eq $Handle })
  } else {
    if (-not $Process -and -not $Match) {
      [Console]::Error.WriteLine('Handle, Process or Match required'); exit 2
    }
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
  if (-not $hit) { [Console]::Error.WriteLine('window not found'); exit 3 }
  return $hit
}

# Поднять окно на передний план. Через ForceForeground (AttachThreadInput),
# потому что обычный SetForegroundWindow молча отказывает чужому процессу — и
# тогда SendInput отправляет ввод в АКТИВНОЕ окно, а не в то, что нам нужно.
function Ensure-Foreground($hwnd) {
  $ok = [DSBGui]::ForceForeground($hwnd)
  if (-not $ok) {
    # Windows не отдала фокус (иногда мешает UIPI или другое приложение сверху).
    # Не падаем: часть программ принимает и background-режим. Но предупреждаем —
    # вызывающий должен понять, что foreground-ввод может уйти не туда.
    [Console]::Error.WriteLine('foreground_denied')
  }
  Start-Sleep -Milliseconds 200
  # Пишем в переменную скрипта, а НЕ в поток вывода: иначе True утечёт в stdout
  # перед JSON-ответом и сломает разбор у вызывающего.
  $script:LastFocusOk = $ok
}

# Пересчёт экранных координат в клиентские координаты окна (для background).
function To-Client($hwnd, $sx, $sy) {
  $p = New-Object 'DSBGui+POINT'
  $p.X = $sx; $p.Y = $sy
  [void][DSBGui]::ScreenToClient($hwnd, [ref]$p)
  return @($p.X, $p.Y)
}

# ---------- карта клавиш ----------

# Имена -> виртуальные коды. Нужны только для комбинаций (ctrl+s, alt+f4).
$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B;
  'enter' = 0x0D; 'return' = 0x0D; 'esc' = 0x1B; 'escape' = 0x1B;
  'tab' = 0x09; 'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E;
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27;
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22;
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75;
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B;
  'insert' = 0x2D; 'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91;
  'a' = 0x41; 'b' = 0x42; 'c' = 0x43; 'd' = 0x44; 'e' = 0x45; 'f' = 0x46; 'g' = 0x47;
  'h' = 0x48; 'i' = 0x49; 'j' = 0x4A; 'k' = 0x4B; 'l' = 0x4C; 'm' = 0x4D; 'n' = 0x4E;
  'o' = 0x4F; 'p' = 0x50; 'q' = 0x51; 'r' = 0x52; 's' = 0x53; 't' = 0x54; 'u' = 0x55;
  'v' = 0x56; 'w' = 0x57; 'x' = 0x58; 'y' = 0x59; 'z' = 0x5A;
  '0' = 0x30; '1' = 0x31; '2' = 0x32; '3' = 0x33; '4' = 0x34; '5' = 0x35;
  '6' = 0x36; '7' = 0x37; '8' = 0x38; '9' = 0x39;
  '=' = 0xBB; '-' = 0xBD; '+' = 0xBB; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF;
  ';' = 0xBA; "'" = 0xDE; '[' = 0xDB; ']' = 0xDD; '\\' = 0xDC; '`' = 0xC0
}

function Resolve-VK($name) {
  $n = $name.ToLower().Trim()
  if ($VK.ContainsKey($n)) { return $VK[$n] }
  [Console]::Error.WriteLine("unknown key: $name"); exit 6
}

# ---------- действия ----------

switch ($Action) {
  'state' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    $r = New-Object 'DSBGui+RECT'
    [void][DSBGui]::GetWindowRect($hwnd, [ref]$r)
    $c = New-Object 'DSBGui+POINT'
    [void][DSBGui]::GetCursorPos([ref]$c)
    $fg = [DSBGui]::GetForegroundWindow()
    $out = [ordered]@{
      process = $hit.process
      title = $hit.title
      handle = $hit.handle
      pid = $hit.id
      rect = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
      foreground = ($fg -eq $hwnd)
      cursor = @{ x = $c.X; y = $c.Y }
      screen = @{ width = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; height = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }
    }
    ConvertTo-Json -InputObject $out -Compress -Depth 5
    exit 0
  }

  'focus' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    Ensure-Foreground $hwnd
    $out = [ordered]@{ focused = $script:LastFocusOk; handle = $hit.handle; title = $hit.title }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'click' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    $downMap = @{ 'left' = [DSBGui]::MOUSEEVENTF_LEFTDOWN; 'right' = [DSBGui]::MOUSEEVENTF_RIGHTDOWN; 'middle' = [DSBGui]::MOUSEEVENTF_MIDDLEDOWN }
    $upMap = @{ 'left' = [DSBGui]::MOUSEEVENTF_LEFTUP; 'right' = [DSBGui]::MOUSEEVENTF_RIGHTUP; 'middle' = [DSBGui]::MOUSEEVENTF_MIDDLEUP }
    if (-not $downMap.ContainsKey($Button)) { [Console]::Error.WriteLine('button must be left/right/middle'); exit 7 }

    if ($Mode -eq 'background') {
      $cp = To-Client $hwnd $X $Y
      $dMsg = @{ 'left' = [DSBGui]::WM_LBUTTONDOWN; 'right' = [DSBGui]::WM_RBUTTONDOWN; 'middle' = [DSBGui]::WM_MBUTTONDOWN }[$Button]
      $uMsg = @{ 'left' = [DSBGui]::WM_LBUTTONUP; 'right' = [DSBGui]::WM_RBUTTONUP; 'middle' = [DSBGui]::WM_MBUTTONUP }[$Button]
      for ($i = 0; $i -lt [Math]::Max(1, $Count); $i++) { [DSBGui]::PostClick($hwnd, $cp[0], $cp[1], $dMsg, $uMsg) }
      $out = [ordered]@{ mode = 'background'; handle = $hit.handle; x = $X; y = $Y; button = $Button; count = [Math]::Max(1, $Count) }
      ConvertTo-Json -InputObject $out -Compress
      exit 0
    }

    Ensure-Foreground $hwnd
    for ($i = 0; $i -lt [Math]::Max(1, $Count); $i++) {
      [void][DSBGui]::SendMouseClick($X, $Y, $downMap[$Button], $upMap[$Button])
      if ($Count -gt 1) { Start-Sleep -Milliseconds 60 }
    }
    $out = [ordered]@{ mode = 'foreground'; handle = $hit.handle; x = $X; y = $Y; button = $Button; count = [Math]::Max(1, $Count) }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'move' {
    $hit = Resolve-Window
    Ensure-Foreground ([IntPtr]$hit.handle)
    [DSBGui]::SendMouseMove($X, $Y)
    $out = [ordered]@{ moved = $true; x = $X; y = $Y }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'drag' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    Ensure-Foreground $hwnd
    [DSBGui]::SendMouseMove($X, $Y)
    Start-Sleep -Milliseconds 60
    $downMap = [DSBGui]::MOUSEEVENTF_LEFTDOWN; $upMap = [DSBGui]::MOUSEEVENTF_LEFTUP
    # Нажать, провести, отпустить через SendInput
    [void][DSBGui]::SendMouseClick($X, $Y, $downMap, 0)
    Start-Sleep -Milliseconds 40
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int]($X + ($ToX - $X) * $i / $steps)
      $ny = [int]($Y + ($ToY - $Y) * $i / $steps)
      [DSBGui]::SendMouseMove($nx, $ny)
      Start-Sleep -Milliseconds 15
    }
    [void][DSBGui]::SendMouseClick($ToX, $ToY, 0, $upMap)
    $out = [ordered]@{ from = @{ x = $X; y = $Y }; to = @{ x = $ToX; y = $ToY } }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'scroll' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    if ($Mode -eq 'background') {
      $cp = To-Client $hwnd $X $Y
      $wparam = [int64]($Delta -shl 16)
      $lp = [IntPtr]([DSBGui]::MakeLParam($cp[0], $cp[1]))
      [void][DSBGui]::PostMessage($hwnd, [DSBGui]::WM_MOUSEWHEEL, [IntPtr]$wparam, $lp)
      $out = [ordered]@{ mode = 'background'; delta = $Delta }
      ConvertTo-Json -InputObject $out -Compress
      exit 0
    }
    Ensure-Foreground $hwnd
    [DSBGui]::SendScroll($X, $Y, $Delta)
    $out = [ordered]@{ mode = 'foreground'; delta = $Delta }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'type' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    if ($Mode -eq 'background') {
      # WM_CHAR в главное окно до текстового поля не доходит: в Win32 поле —
      # отдельный дочерний контрол. Ищем его и шлём текст прямо туда.
      # Если контрола нет (Electron, WPF, Qt — там всё рисуется на канве),
      # честно говорим об этом, а не делаем вид, что ввод удался.
      $editor = [DSBGui]::FindEditorChild($hwnd)
      if ($editor -eq [IntPtr]::Zero) {
        [Console]::Error.WriteLine('no_editable_child: window has no Edit/RichEdit child control - background input impossible, try Mode=foreground')
        exit 10
      }
      [DSBGui]::PostText($editor, $Text)
      $out = [ordered]@{
        mode = 'background'
        chars = $Text.Length
        editorClass = [DSBGui]::ClassName($editor)
      }
      ConvertTo-Json -InputObject $out -Compress
      exit 0
    }
    Ensure-Foreground $hwnd
    [void][DSBGui]::SendUnicodeText($Text)
    $out = [ordered]@{ mode = 'foreground'; chars = $Text.Length }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'key' {
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    # Keys: "ctrl+s" или "alt+f4" или "enter". Разбираем по '+'.
    $parts = $Keys -split '\+'
    $mods = @()
    $main = $null
    foreach ($p in $parts) {
      $pn = $p.ToLower().Trim()
      if ($pn -in @('ctrl', 'control', 'alt', 'shift', 'win')) { $mods += (Resolve-VK $pn) }
      else { $main = $pn }
    }
    if (-not $main) { [Console]::Error.WriteLine('key: нужна основная клавиша'); exit 8 }
    $mainVk = Resolve-VK $main

    if ($Mode -eq 'background') {
      foreach ($m in $mods) { [void][DSBGui]::PostMessage($hwnd, [DSBGui]::WM_KEYDOWN, [IntPtr]$m, [IntPtr]0) }
      [void][DSBGui]::PostMessage($hwnd, [DSBGui]::WM_KEYDOWN, [IntPtr]$mainVk, [IntPtr]0)
      [void][DSBGui]::PostMessage($hwnd, [DSBGui]::WM_KEYUP, [IntPtr]$mainVk, [IntPtr]0)
      for ($i = $mods.Count - 1; $i -ge 0; $i--) { [void][DSBGui]::PostMessage($hwnd, [DSBGui]::WM_KEYUP, [IntPtr]$mods[$i], [IntPtr]0) }
      $out = [ordered]@{ mode = 'background'; keys = $Keys }
      ConvertTo-Json -InputObject $out -Compress
      exit 0
    }

    Ensure-Foreground $hwnd
    foreach ($m in $mods) { [DSBGui]::KeyDown([byte]$m) }
    [DSBGui]::KeyDown([byte]$mainVk)
    Start-Sleep -Milliseconds 30
    [DSBGui]::KeyUp([byte]$mainVk)
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { [DSBGui]::KeyUp([byte]$mods[$i]) }
    $out = [ordered]@{ mode = 'foreground'; keys = $Keys }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'set_value' {
    # Заменить содержимое текстового поля целиком. Через семантические сообщения
    # Edit-контрола (EM_SETSEL + EM_REPLACESEL), а не через ctrl+a: комбинация
    # модификаторов через PostMessage не собирается, а эти сообщения работают
    # в фоне и не трогают фокус.
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    $editor = [DSBGui]::FindEditorChild($hwnd)
    if ($editor -eq [IntPtr]::Zero) {
      [Console]::Error.WriteLine('no_editable_child: window has no Edit/RichEdit child control - set_value impossible')
      exit 10
    }
    [void][DSBGui]::SetControlText($editor, $Text)
    Start-Sleep -Milliseconds 150
    $after = [DSBGui]::ControlText($editor)
    $out = [ordered]@{
      editorClass = [DSBGui]::ClassName($editor)
      chars = $Text.Length
      applied = ($after -eq $Text)
    }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'read' {
    # Чтение текста из окна. Пробуем три пути:
    #   1. само окно через WM_GETTEXT (редко что-то даёт, кроме заголовка);
    #   2. дочерние контролы класса Edit/RichEdit (блокнот, старые программы);
    #   3. если ничего — отдаём заголовок и список классов детей, чтобы было
    #      видно, за что цепляться дальше (современные UI текст так не отдают).
    $hit = Resolve-Window
    $hwnd = [IntPtr]$hit.handle
    $result = [ordered]@{
      process = $hit.process
      title = $hit.title
      handle = $hit.handle
    }

    $children = [DSBGui]::ChildWindows($hwnd)
    $classes = @()
    $texts = @()
    foreach ($ch in $children) {
      $cls = [DSBGui]::ClassName($ch)
      $classes += $cls
      if ($cls -match '^(Edit|RichEdit|RICHEDIT|Scintilla)') {
        $t = [DSBGui]::ControlText($ch)
        if ($t) { $texts += @{ class = $cls; text = $t } }
      }
    }
    $result['childClasses'] = @($classes | Select-Object -Unique)
    $result['childCount'] = $children.Count
    $result['editableTexts'] = @($texts)
    if ($texts.Count -gt 0) { $result['text'] = ($texts | ForEach-Object { $_.text }) -join "\n" }
    ConvertTo-Json -InputObject $result -Compress -Depth 6
    exit 0
  }

  'clipboard-get' {
    $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    $out = [ordered]@{ text = [string]$text }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  'clipboard-set' {
    Set-Clipboard -Value $Text
    $out = [ordered]@{ set = $true; chars = $Text.Length }
    ConvertTo-Json -InputObject $out -Compress
    exit 0
  }

  default {
    [Console]::Error.WriteLine("unknown action: $Action"); exit 9
  }
}

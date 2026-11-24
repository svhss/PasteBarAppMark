//! Windows only: open the Quick Paste window with Win+V.
//!
//! Windows uses Win+V for its own clipboard panel, so a normal global
//! shortcut (RegisterHotKey) cannot get it. This module installs a low-level
//! keyboard hook (WH_KEYBOARD_LL). The hook sees Win+V before Windows does,
//! blocks it, and sends an event. The main window then opens Quick Paste.
//!
//! The hook runs on its own thread with a message loop. `set_enabled(true)`
//! starts the thread, `set_enabled(false)` stops it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Manager};
use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
use winapi::um::libloaderapi::GetModuleHandleW;
use winapi::um::processthreadsapi::GetCurrentThreadId;
use winapi::um::winuser::{
  CallNextHookEx, DispatchMessageW, GetAsyncKeyState, GetMessageW, PostThreadMessageW, SendInput,
  SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, INPUT, INPUT_KEYBOARD,
  KBDLLHOOKSTRUCT, KEYBDINPUT, KEYEVENTF_KEYUP, LLKHF_INJECTED, MSG, VK_CONTROL, VK_LWIN, VK_MENU,
  VK_RWIN, VK_SHIFT, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Event sent when the user presses Win+V. Only the main window acts on it.
pub const WIN_V_EVENT: &str = "quickpaste://win-v";

const VK_V: u32 = 0x56;
/// An unassigned virtual key. Sending it while Win is held down stops
/// Windows from opening the Start menu when the Win key is released.
const VK_MENU_MASK: u16 = 0xE8;

static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
/// The state the user asked for last. Covers a `stop` that comes while the thread starts.
static IS_WANTED: AtomicBool = AtomicBool::new(false);
/// True from `start` until the hook thread ends.
static IS_RUNNING: AtomicBool = AtomicBool::new(false);
/// Thread id of the hook thread, 0 when the hook is not running.
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// True while we block a V key-down, so we also block auto-repeat and the key-up.
static IS_V_BLOCKED: AtomicBool = AtomicBool::new(false);

fn is_key_down(virtual_key: i32) -> bool {
  // The high bit is set when the key is down.
  unsafe { GetAsyncKeyState(virtual_key) < 0 }
}

fn send_menu_mask_key() {
  unsafe {
    let mut inputs: [INPUT; 2] = std::mem::zeroed();

    inputs[0].type_ = INPUT_KEYBOARD;
    *inputs[0].u.ki_mut() = KEYBDINPUT {
      wVk: VK_MENU_MASK,
      wScan: 0,
      dwFlags: 0,
      time: 0,
      dwExtraInfo: 0,
    };

    inputs[1].type_ = INPUT_KEYBOARD;
    *inputs[1].u.ki_mut() = KEYBDINPUT {
      wVk: VK_MENU_MASK,
      wScan: 0,
      dwFlags: KEYEVENTF_KEYUP,
      time: 0,
      dwExtraInfo: 0,
    };

    SendInput(
      inputs.len() as u32,
      inputs.as_mut_ptr(),
      std::mem::size_of::<INPUT>() as i32,
    );
  }
}

fn request_quick_paste_window() {
  let app_handle = APP_HANDLE.lock().ok().and_then(|handle| handle.clone());

  if let Some(app_handle) = app_handle {
    // Do not do slow work inside the hook. Windows removes hooks that are too slow.
    thread::spawn(move || {
      if let Err(e) = app_handle.emit_all(WIN_V_EVENT, ()) {
        eprintln!("Failed to send Win+V event: {}", e);
      }
    });
  }
}

unsafe extern "system" fn keyboard_hook(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
  if code == HC_ACTION {
    let key = &*(l_param as *const KBDLLHOOKSTRUCT);
    let is_injected = key.flags & LLKHF_INJECTED != 0;

    if key.vkCode == VK_V && !is_injected {
      let message = w_param as u32;
      let is_key_down_message = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      let is_key_up_message = message == WM_KEYUP || message == WM_SYSKEYUP;

      if is_key_down_message {
        let is_win_down = is_key_down(VK_LWIN) || is_key_down(VK_RWIN);
        let has_other_modifiers =
          is_key_down(VK_CONTROL) || is_key_down(VK_MENU) || is_key_down(VK_SHIFT);

        if is_win_down && !has_other_modifiers {
          // Only the first key-down opens the window. Auto-repeat is blocked too.
          if !IS_V_BLOCKED.swap(true, Ordering::SeqCst) {
            send_menu_mask_key();
            request_quick_paste_window();
          }
          return 1;
        }
      } else if is_key_up_message && IS_V_BLOCKED.swap(false, Ordering::SeqCst) {
        return 1;
      }
    }
  }

  CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
}

fn start(app_handle: AppHandle) {
  if let Ok(mut handle) = APP_HANDLE.lock() {
    *handle = Some(app_handle);
  }

  if IS_RUNNING
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_err()
  {
    return; // Already running
  }

  thread::spawn(|| unsafe {
    let hook = SetWindowsHookExW(
      WH_KEYBOARD_LL,
      Some(keyboard_hook),
      GetModuleHandleW(std::ptr::null()),
      0,
    );

    if hook.is_null() {
      eprintln!("Failed to install the Win+V keyboard hook");
      IS_RUNNING.store(false, Ordering::SeqCst);
      return;
    }

    HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

    // A low-level hook needs a message loop on the thread that installed it.
    let mut message: MSG = std::mem::zeroed();
    while IS_WANTED.load(Ordering::SeqCst)
      && GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0
    {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }

    UnhookWindowsHookEx(hook);
    IS_V_BLOCKED.store(false, Ordering::SeqCst);
    HOOK_THREAD_ID.store(0, Ordering::SeqCst);
    IS_RUNNING.store(false, Ordering::SeqCst);
  });
}

fn stop() {
  let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
  if thread_id != 0 {
    unsafe {
      PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
    }
  }
}

pub fn set_enabled(app_handle: AppHandle, is_enabled: bool) {
  IS_WANTED.store(is_enabled, Ordering::SeqCst);
  if is_enabled {
    start(app_handle);
  } else {
    stop();
  }
}

//! Windows only: Win+V always opens (or closes) the Quick Paste window.
//!
//! Windows uses Win+V for its own clipboard panel, so a normal global
//! shortcut (RegisterHotKey) cannot get it. This module installs a low-level
//! keyboard hook (WH_KEYBOARD_LL) when the app starts. The hook sees Win+V
//! before Windows does, blocks it, and opens the Quick Paste window.
//!
//! The hook runs on its own thread with a message loop, for the full life of the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;

use tauri::AppHandle;
use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
use winapi::um::libloaderapi::GetModuleHandleW;
use winapi::um::winuser::{
  CallNextHookEx, DispatchMessageW, GetAsyncKeyState, GetMessageW, SendInput, SetWindowsHookExW,
  TranslateMessage, HC_ACTION, INPUT, INPUT_KEYBOARD, KBDLLHOOKSTRUCT, KEYBDINPUT, KEYEVENTF_KEYUP,
  LLKHF_INJECTED, MSG, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, WH_KEYBOARD_LL, WM_KEYDOWN,
  WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const VK_V: u32 = 0x56;
/// An unassigned virtual key. Sending it while Win is held down stops
/// Windows from opening the Start menu when the Win key is released.
const VK_MENU_MASK: u16 = 0xE8;

static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
/// True after `start` was called once. The hook is installed only one time.
static IS_STARTED: AtomicBool = AtomicBool::new(false);
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

fn toggle_quick_paste_window() {
  let app_handle = APP_HANDLE.lock().ok().and_then(|handle| handle.clone());

  if let Some(app_handle) = app_handle {
    // Do not do slow work inside the hook. Windows removes hooks that are too slow.
    tauri::async_runtime::spawn(async move {
      if let Err(e) =
        crate::open_quickpaste_window(app_handle, "PasteBar Quick Paste".to_string()).await
      {
        eprintln!("Failed to open Quick Paste window: {}", e);
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
          // Only the first key-down toggles the window. Auto-repeat is blocked too.
          if !IS_V_BLOCKED.swap(true, Ordering::SeqCst) {
            send_menu_mask_key();
            toggle_quick_paste_window();
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

/// Installs the Win+V hook. Call it one time, when the app starts.
pub fn start(app_handle: AppHandle) {
  if let Ok(mut handle) = APP_HANDLE.lock() {
    *handle = Some(app_handle);
  }

  if IS_STARTED.swap(true, Ordering::SeqCst) {
    return; // Already started
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
      return;
    }

    // A low-level hook needs a message loop on the thread that installed it.
    let mut message: MSG = std::mem::zeroed();
    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  });
}

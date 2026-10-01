use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use flate2::bufread::GzDecoder;
use tar::Archive;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Backend(Mutex<Option<Child>>);

fn sidecar_node() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    #[cfg(windows)]
    {
        let mut p = dir.join("photocull-node");
        p.set_extension("exe");
        p
    }
    #[cfg(not(windows))]
    {
        dir.join("photocull-node")
    }
}

fn find_app_dir(resource: &Path) -> Option<PathBuf> {
    for candidate in [
        resource.join("app"),
        resource.join("resources").join("app"),
        resource.to_path_buf(),
    ] {
        if candidate.join("server").join("index.js").is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_tarball(app: &tauri::AppHandle) -> Option<PathBuf> {
    let names = ["app.tar.gz", "resources/app.tar.gz"];
    for name in names {
        if let Ok(p) = app.path().resolve(name, BaseDirectory::Resource) {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        for name in names {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn extract_tar_gz(src: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(src).map_err(|e| format!("打不开运行时包 {}: {e}", src.display()))?;
    let gz = GzDecoder::new(BufReader::new(file));
    let mut archive = Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| format!("解压运行时失败: {e}"))?;
    Ok(())
}

fn ensure_runtime(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        if let Some(found) = find_app_dir(&dir) {
            return Ok(found);
        }
    }

    let tarball = find_tarball(app).ok_or_else(|| {
        "安装包不完整：找不到 app.tar.gz。请重新安装 PhotoCull。".to_string()
    })?;

    let dest = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime")
        .join(app.package_info().version.to_string());
    let marker = dest.join(".ok");
    if marker.is_file() && dest.join("server").join("index.js").is_file() {
        return Ok(dest);
    }

    if let Some(parent) = dest.parent() {
        if parent.exists() {
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    if entry.path() != dest {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }

    if dest.exists() {
        let _ = fs::remove_dir_all(&dest);
    }
    fs::create_dir_all(&dest).map_err(|e| format!("无法创建运行时目录: {e}"))?;
    extract_tar_gz(&tarball, &dest)?;
    if !dest.join("server").join("index.js").is_file() {
        return Err("运行时包解压后缺少 server/index.js".into());
    }
    let _ = fs::write(&marker, b"ok");
    Ok(dest)
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    match ensure_runtime(app) {
        Ok(app_dir) => {
            let node = sidecar_node();
            if node.is_file() {
                return Ok((node, app_dir));
            }
            // 开发模式：资源目录可能就是解压后的运行时，但 sidecar 还没打进来。
            if cfg!(debug_assertions) {
                let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
                let root = root.canonicalize().unwrap_or(root);
                if root.join("server").join("index.js").is_file() {
                    return Ok((PathBuf::from("node"), root));
                }
            }
            Err(format!("找不到捆绑的 Node：{}", node.display()))
        }
        Err(err) => {
            if cfg!(debug_assertions) {
                let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
                let root = root.canonicalize().unwrap_or(root);
                if root.join("server").join("index.js").is_file() {
                    return Ok((PathBuf::from("node"), root));
                }
            }
            Err(err)
        }
    }
}

fn wait_ready(path: &Path, child: &mut Child, timeout: Duration) -> Result<String, String> {
    let start = Instant::now();
    loop {
        if let Ok(url) = fs::read_to_string(path) {
            let url = url.trim();
            if url.starts_with("http://") || url.starts_with("https://") {
                return Ok(url.to_string());
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("选片服务启动失败，进程已退出（{status}）"));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("无法确认选片服务状态: {e}")),
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("选片服务启动超时。".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => break,
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn start_backend(app: &tauri::AppHandle) -> Result<String, String> {
    let (node, app_dir) = resolve_paths(app)?;
    let entry = app_dir.join("server").join("index.js");
    if !entry.is_file() {
        return Err(format!("找不到服务入口 {}", entry.display()));
    }

    let ready_file = std::env::temp_dir().join(format!("photocull-ready-{}", std::process::id()));
    let _ = fs::remove_file(&ready_file);

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&app_dir)
        .env("PHOTOCULL_TAURI", "1")
        .env("PHOTOCULL_READY_FILE", &ready_file)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动选片服务（{}）: {e}", node.display()))?;
    let url = match wait_ready(&ready_file, &mut child, Duration::from_secs(45)) {
        Ok(url) => url,
        Err(err) => {
            terminate(&mut child);
            return Err(err);
        }
    };
    let _ = fs::remove_file(&ready_file);
    app.manage(Backend(Mutex::new(Some(child))));
    Ok(url)
}

fn open_main_window(app: &tauri::App, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let parsed: url::Url = url.parse()?;
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("PhotoCull")
        .inner_size(1400.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .disable_drag_drop_handler()
        .maximizable(false)
        .minimizable(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    builder.build()?;
    Ok(())
}

fn alert(msg: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("PhotoCull")
        .set_description(msg)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        match start_backend(app.handle()) {
            Ok(url) => open_main_window(app, &url),
            Err(err) => {
                eprintln!("PhotoCull: {err}");
                alert(&err);
                Err(err.into())
            }
        }
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PhotoCull");

    app.run(|handle, event| {
        match event {
            RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                if let Some(state) = handle.try_state::<Backend>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            terminate(&mut child);
                        }
                    }
                }
            }
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => {
                handle.exit(0);
            }
            _ => {}
        }
    });
}

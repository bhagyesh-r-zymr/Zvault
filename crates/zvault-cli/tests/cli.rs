//! Runs the real `zv` binary against a fake Zvault app on a Unix socket.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

static NEXT: AtomicUsize = AtomicUsize::new(0);

type Handler = Box<dyn Fn(&Value) -> Value + Send + Sync>;

/// A stand-in for the desktop app: answers one request per connection.
struct App {
    dir: PathBuf,
    sock: PathBuf,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl App {
    fn start(handler: Handler) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "zvt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s");
        let listener = UnixListener::bind(&sock).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut line = String::new();
                if BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap_or(0)
                    == 0
                {
                    continue;
                }
                let req: Value = serde_json::from_str(&line).unwrap();
                let res = handler(&req);
                log.lock().unwrap().push(req);
                let _ = writeln!(stream, "{res}");
            }
        });
        Self { dir, sock, seen }
    }

    /// An app that answers like a healthy, unlocked one.
    fn healthy() -> Self {
        Self::start(Box::new(|req| happy(&req["body"])))
    }

    fn zv(&self, args: &[&str]) -> Output {
        self.zv_with(args, "", &[])
    }

    fn zv_with(&self, args: &[&str], stdin: &str, env: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_zv"));
        cmd.args(args)
            .env_remove("ZV_AGENT")
            .env_remove("ZVAULT_TOKEN")
            .env("ZV_SOCKET", &self.sock)
            .env("HOME", &self.dir)
            .env("XDG_CONFIG_HOME", self.dir.join("config"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn last(&self) -> Value {
        self.seen.lock().unwrap().last().cloned().unwrap()
    }

    fn requests(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn happy(body: &Value) -> Value {
    match body["type"].as_str().unwrap() {
        "appStatus" => {
            json!({"type":"appStatus","locked":false,"signedIn":true,"signedInSecs":300})
        }
        "unlock" | "signIn" | "signOut" | "set" | "unpair" => json!({"type":"ok"}),
        "list" => json!({"type":"list","refs":[
            "zv://web/development/API_KEY",
            "zv://web/production/stripe/STRIPE_KEY",
            "zv://api/production/DB_URL"
        ]}),
        "fetch" => {
            let values: Vec<Value> = body["refs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| json!({"reference": r, "value": "hunter2-value"}))
                .collect();
            json!({"type":"secrets","values":values})
        }
        "export" => json!({"type":"secrets","values":[
            {"reference":"zv://web/development/API_KEY","value":"abc123"},
            {"reference":"zv://web/development/DB_URL","value":"it's \"quoted\""}
        ]}),
        "copy" => json!({"type":"copied","clearAfterSecs":45}),
        "structure" => json!({"type":"structure","projects":[
            {"slug":"web","name":"Web","owner":true,
             "environments":[
                {"slug":"development","name":"Development","kind":"development"},
                {"slug":"qa","name":"QA","kind":"custom","inheritsFrom":"development","locked":true}
             ],
             "folders":[{"slug":"stripe","name":"Stripe"}]},
            {"slug":"empty","name":"Empty","owner":false}
        ]}),
        "change" => json!({"type":"changed","message":"Done."}),
        "items" => json!({"type":"items","items":[
            {"id":"i1","title":"GitHub","username":"me","url":"https://github.com","hasTotp":true},
            {"id":"i2","title":"Bare"}
        ]}),
        "itemGet" => json!({"type":"item","id":"i1","title":"GitHub","username":"me",
            "password":"pw-1","urls":["https://github.com"],"notes":"a note",
            "totp":"otpauth://totp/x?secret=ABC","otp":"123456"}),
        "itemPut" | "itemDelete" => json!({"type":"changed","message":"Saved the item."}),
        "pair" => json!({"type":"paired","agentId":"agt_1","name":body["name"],"token":"tok-1"}),
        "status" => json!({"type":"status","agentId":"agt_1","name":"Claude Code","paused":false,
            "approval":"session15m","scopes":["zv://web/development/*"]}),
        other => panic!("unexpected request {other}"),
    }
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap()
}

#[test]
fn status_reports_a_running_app() {
    let app = App::healthy();
    let o = app.zv(&["status"]);
    assert_eq!(code(&o), 0);
    let text = out(&o);
    assert!(text.contains("running"));
    assert!(text.contains("unlocked"));
    assert!(text.contains("5 min left"));
    assert!(text.contains("0 paired"));

    let o = app.zv(&["status", "--json"]);
    let v: Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["running"], true);
    assert_eq!(v["signedInSecs"], 300);
}

#[test]
fn status_without_the_app_exits_2() {
    let app = App::healthy();
    let o = app.zv_with(
        &["status"],
        "",
        &[("ZV_SOCKET", app.dir.join("missing").to_str().unwrap())],
    );
    assert_eq!(code(&o), 2);
    assert!(out(&o).contains("not running"));
    let o = app.zv_with(
        &["status", "--json"],
        "",
        &[("ZV_SOCKET", app.dir.join("missing").to_str().unwrap())],
    );
    assert_eq!(code(&o), 2);
    assert!(out(&o).contains("\"running\":false"));
    let o = app.zv_with(
        &["ls"],
        "",
        &[("ZV_SOCKET", app.dir.join("missing").to_str().unwrap())],
    );
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("not running"));
}

#[test]
fn status_for_a_terminal_that_is_not_signed_in() {
    let app = App::start(Box::new(
        |_| json!({"type":"appStatus","locked":true,"signedIn":false,"signedInSecs":null}),
    ));
    let text = out(&app.zv(&["status"]));
    assert!(text.contains("locked"));
    assert!(text.contains("not signed in"));
}

#[test]
fn unlock_signin_and_signout_talk_to_the_app() {
    let app = App::healthy();
    assert!(out(&app.zv(&["unlock"])).contains("unlocked"));
    assert_eq!(app.last()["body"]["type"], "unlock");
    assert!(out(&app.zv(&["signin"])).contains("signed in"));
    assert_eq!(app.last()["body"]["type"], "signIn");
    assert!(out(&app.zv(&["signout"])).contains("Signed out"));
    assert_eq!(app.last()["body"]["type"], "signOut");
}

#[test]
fn projects_environments_and_folders_are_listed() {
    let app = App::healthy();
    let text = out(&app.zv(&["projects"]));
    assert!(text.contains("zv://web\tWeb"));
    assert!(text.contains("zv://empty\tEmpty (shared)"));
    assert!(text.contains("falls back to development"));
    assert!(text.contains("no access to values"));
    assert!(text.contains("folders: stripe"));

    let v: Value = serde_json::from_str(&out(&app.zv(&["projects", "--json"]))).unwrap();
    assert_eq!(v[0]["slug"], "web");
    assert!(out(&app.zv(&["project", "ls"])).contains("zv://web"));

    assert!(out(&app.zv(&["environment", "list", "zv://web"])).contains("zv://web/qa"));
    let v: Value =
        serde_json::from_str(&out(&app.zv(&["envs", "ls", "zv://web", "--json"]))).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 2);
    assert!(
        out(&app.zv(&["environment", "list", "zv://empty"])).contains("has no environments yet")
    );

    assert!(out(&app.zv(&["folder", "list", "zv://web"])).contains("stripe\tStripe"));
    let v: Value =
        serde_json::from_str(&out(&app.zv(&["folders", "ls", "zv://web", "--json"]))).unwrap();
    assert_eq!(v[0]["slug"], "stripe");
    assert!(out(&app.zv(&["folder", "list", "zv://empty"])).contains("has no folders"));

    let o = app.zv(&["folder", "list", "zv://nope"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("there is no project zv://nope"));
}

#[test]
fn an_empty_account_suggests_creating_a_project() {
    let app = App::start(Box::new(|req| {
        match req["body"]["type"].as_str().unwrap() {
            "structure" => json!({"type":"structure","projects":[]}),
            "items" => json!({"type":"items","items":[]}),
            "list" => json!({"type":"list","refs":[]}),
            other => panic!("unexpected {other}"),
        }
    }));
    assert!(out(&app.zv(&["projects"])).contains("No projects yet"));
    assert!(out(&app.zv(&["items"])).contains("Your vault is empty"));
    assert_eq!(out(&app.zv(&["ls"])), "");
}

#[test]
fn ls_lists_places_and_secrets() {
    let app = App::healthy();
    let text = out(&app.zv(&["ls"]));
    assert!(text.contains("web"));
    assert!(text.contains("api"));
    let text = out(&app.zv(&["ls", "-r", "zv://web"]));
    assert!(text.contains("zv://web/development/API_KEY"));
    assert!(text.contains("zv://web/production/stripe/STRIPE_KEY"));
    let v: Value = serde_json::from_str(&out(&app.zv(&["ls", "--json", "zv://web"]))).unwrap();
    assert!(v.as_array().unwrap().len() >= 2);
    assert_eq!(code(&app.zv(&["ls", "not-a-place"])), 64);
}

#[test]
fn read_prints_the_value() {
    let app = App::healthy();
    let o = app.zv(&["read", "zv://web/development/API_KEY"]);
    assert_eq!(out(&o), "hunter2-value\n");
    let body = app.last()["body"].clone();
    assert_eq!(body["type"], "fetch");
    assert_eq!(body["purpose"]["kind"], "read");
    let o = app.zv(&["read", "-n", "zv://web/development/API_KEY"]);
    assert_eq!(out(&o), "hunter2-value");
    assert_eq!(code(&app.zv(&["read", "zv://bad"])), 64);
}

#[test]
fn env_prints_every_format() {
    let app = App::healthy();
    let dotenv = out(&app.zv(&["env", "zv://web/development"]));
    assert!(dotenv.contains("API_KEY=\"abc123\""));
    let shell = out(&app.zv(&["env", "zv://web/development", "--format", "shell"]));
    assert!(shell.contains("export API_KEY='abc123'"));
    let json_text = out(&app.zv(&["env", "zv://web/development", "--format", "json"]));
    let v: Value = serde_json::from_str(&json_text).unwrap();
    assert_eq!(v["DB_URL"], "it's \"quoted\"");
}

#[test]
fn run_passes_secrets_to_the_child_and_masks_them() {
    let app = App::healthy();
    let o = app.zv(&[
        "run",
        "--env",
        "TOKEN=zv://web/development/API_KEY",
        "--",
        "sh",
        "-c",
        "echo value is $TOKEN; exit 3",
    ]);
    assert_eq!(code(&o), 3);
    let text = out(&o);
    assert!(text.contains("value is"));
    assert!(!text.contains("hunter2-value"));

    let o = app.zv(&[
        "run",
        "--env-from",
        "zv://web/development",
        "--env",
        "API_KEY=zv://web/development/API_KEY",
        "--no-mask",
        "--",
        "sh",
        "-c",
        "printf '%s' \"$DB_URL\"",
    ]);
    assert_eq!(code(&o), 0);
    assert_eq!(out(&o), "it's \"quoted\"");
}

#[test]
fn run_checks_its_arguments() {
    let app = App::healthy();
    let o = app.zv(&["run", "--", "true"]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("--env NAME=PATH"));
    let o = app.zv(&["run", "--env", "NOEQUALS", "--", "true"]);
    assert_eq!(code(&o), 64);
    let o = app.zv(&["run", "--env", "1BAD=zv://a/b/C", "--", "true"]);
    assert_eq!(code(&o), 64);
    let o = app.zv(&[
        "run",
        "--env",
        "A=zv://a/b/C",
        "--env",
        "A=zv://a/b/D",
        "--",
        "true",
    ]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("set twice"));
    let o = app.zv(&[
        "run",
        "--env",
        "A=zv://web/development/API_KEY",
        "--",
        "/definitely/not/a/program",
    ]);
    assert_eq!(code(&o), 127);
}

#[test]
fn set_reads_stdin_or_generates_a_value() {
    let app = App::healthy();
    let o = app.zv_with(&["set", "zv://web/development/NEW"], "s3cret\n", &[]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).contains("Saved zv://web/development/NEW"));
    let body = app.last()["body"].clone();
    assert_eq!(body["type"], "set");
    assert_eq!(body["value"], "s3cret");

    let o = app.zv(&["set", "zv://web/development/NEW", "--generate", "20"]);
    assert_eq!(code(&o), 0);
    assert_eq!(app.last()["body"]["value"].as_str().unwrap().len(), 20);
    let o = app.zv(&["set", "zv://web/development/NEW", "--generate"]);
    assert_eq!(app.last()["body"]["value"].as_str().unwrap().len(), 32);
    assert_eq!(code(&o), 0);

    let before = app.requests();
    let o = app.zv(&["set", "zv://web/development/NEW", "--generate", "2"]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("--generate takes a length"));
    let o = app.zv_with(&["set", "zv://web/development/NEW"], "\n", &[]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("empty"));
    assert_eq!(app.requests(), before);
}

#[test]
fn copy_says_when_the_clipboard_clears() {
    let app = App::healthy();
    let o = app.zv(&["copy", "zv://web/development/API_KEY"]);
    assert!(out(&o).contains("45 seconds"));
}

#[test]
fn deleting_needs_yes() {
    let app = App::healthy();
    let o = app.zv(&["rm", "zv://web/development/API_KEY"]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("--yes"));
    let o = app.zv(&["rm", "zv://web/development/API_KEY", "--all-environments"]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("every environment"));
    assert_eq!(app.requests(), 0);

    let o = app.zv(&["rm", "zv://web/development/API_KEY", "--yes"]);
    assert_eq!(code(&o), 0);
    assert_eq!(out(&o), "Done.\n");
    assert_eq!(app.last()["body"]["change"]["op"], "deleteSecret");

    for args in [
        vec!["project", "delete", "zv://web"],
        vec!["environment", "delete", "zv://web/qa"],
        vec!["folder", "delete", "zv://web", "stripe"],
        vec!["item", "delete", "GitHub"],
    ] {
        let o = app.zv(&args);
        assert_eq!(code(&o), 64, "{args:?}");
        assert!(err(&o).contains("--yes"));
    }
    for args in [
        vec!["project", "delete", "zv://web", "--yes"],
        vec!["environment", "delete", "zv://web/qa", "--yes"],
        vec!["folder", "delete", "zv://web", "stripe", "--yes"],
        vec!["item", "delete", "GitHub", "--yes"],
    ] {
        assert_eq!(code(&app.zv(&args)), 0, "{args:?}");
    }
}

#[test]
fn project_environment_and_folder_changes_are_sent_as_changes() {
    let app = App::healthy();
    let change = |app: &App, args: &[&str]| {
        let o = app.zv(args);
        assert_eq!(code(&o), 0, "{args:?}: {}", err(&o));
        assert_eq!(out(&o), "Done.\n");
        app.last()["body"]["change"].clone()
    };

    let c = change(
        &app,
        &[
            "project",
            "create",
            "Payments",
            "--env",
            "Development",
            "--env",
            "Production",
        ],
    );
    assert_eq!(c["op"], "createProject");
    assert_eq!(c["environments"], json!(["Development", "Production"]));

    let c = change(
        &app,
        &["project", "rename", "zv://web", "Website", "--slug", "site"],
    );
    assert_eq!(c["op"], "updateProject");
    assert_eq!(c["slug"], "site");

    let c = change(
        &app,
        &[
            "environment",
            "create",
            "zv://web",
            "QA",
            "--kind",
            "staging",
            "--inherits",
            "development",
        ],
    );
    assert_eq!(c["op"], "createEnvironment");
    assert_eq!(c["kind"], "staging");
    assert_eq!(c["inheritsFrom"], "development");

    let c = change(
        &app,
        &[
            "environment",
            "edit",
            "zv://web/qa",
            "--name",
            "Quality",
            "--no-inherit",
        ],
    );
    assert_eq!(c["op"], "updateEnvironment");
    assert_eq!(c["noFallback"], true);

    let c = change(&app, &["folder", "create", "zv://web", "Stripe"]);
    assert_eq!(c["op"], "createFolder");
    let c = change(&app, &["folder", "rename", "zv://web", "stripe", "Billing"]);
    assert_eq!(c["op"], "updateFolder");

    let c = change(&app, &["sync", "zv://web/production"]);
    assert_eq!(c["op"], "syncEnvironment");
    assert_eq!(c["environment"], "production");

    let o = app.zv(&["environment", "create", "zv://web", "X", "--kind", "bogus"]);
    assert_eq!(code(&o), 2);
    assert_eq!(code(&app.zv(&["sync", "zv://web"])), 64);
    assert_eq!(code(&app.zv(&["project", "rename", "web"])), 64);
}

#[test]
fn a_newer_command_on_an_older_app_says_to_update() {
    let app = App::start(Box::new(
        |_| json!({"type":"error","code":"badRequest","message":"unknown"}),
    ));
    let o = app.zv(&["project", "create", "X"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("update Zvault"));
}

#[test]
fn items_can_be_listed_shown_created_and_edited() {
    let app = App::healthy();
    let text = out(&app.zv(&["items"]));
    assert!(text.contains("i1\tGitHub\tme\thttps://github.com\t[2FA]"));
    assert!(text.contains("i2\tBare"));
    let v: Value = serde_json::from_str(&out(&app.zv(&["item", "list", "--json"]))).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 2);

    let text = out(&app.zv(&["item", "get", "GitHub"]));
    assert!(text.contains("Password:  pw-1"));
    assert!(text.contains("One-time:  123456"));
    assert!(text.contains("Notes:     a note"));
    assert!(text.contains("Website:   https://github.com"));
    let v: Value =
        serde_json::from_str(&out(&app.zv(&["item", "get", "GitHub", "--json"]))).unwrap();
    assert_eq!(v["username"], "me");
    for (field, want) in [
        ("id", "i1"),
        ("title", "GitHub"),
        ("username", "me"),
        ("password", "pw-1"),
        ("url", "https://github.com"),
        ("notes", "a note"),
        ("totp", "otpauth://totp/x?secret=ABC"),
        ("otp", "123456"),
    ] {
        let o = app.zv(&["item", "get", "GitHub", "--field", field]);
        assert_eq!(out(&o), want, "{field}");
    }

    let o = app.zv(&[
        "item",
        "create",
        "--title",
        "Bank",
        "--username",
        "me",
        "--url",
        "https://bank.example",
        "--notes",
        "n",
        "--generate",
    ]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let body = app.last()["body"].clone();
    assert_eq!(body["type"], "itemPut");
    assert_eq!(body["patch"]["title"], "Bank");
    assert_eq!(body["patch"]["password"].as_str().unwrap().len(), 32);

    let o = app.zv_with(
        &["item", "edit", "Bank", "--password-stdin"],
        "new-pass\n",
        &[],
    );
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(app.last()["body"]["patch"]["password"], "new-pass");
    assert_eq!(app.last()["body"]["item"], "Bank");

    let o = app.zv(&["item", "create", "--generate", "3"]);
    assert_eq!(code(&o), 64);
    let o = app.zv(&["item", "edit", "Bank"]);
    assert_eq!(code(&o), 64);
}

#[test]
fn an_item_without_a_one_time_password_has_no_otp_field() {
    let app = App::start(Box::new(|_| {
        json!({"type":"item","id":"i1","title":"T","username":"u","password":"p",
            "urls":[],"notes":"","totp":""})
    }));
    let o = app.zv(&["item", "get", "T", "--field", "otp"]);
    assert_eq!(code(&o), 64);
    assert!(err(&o).contains("no one-time password"));
    let text = out(&app.zv(&["item", "get", "T"]));
    assert!(!text.contains("One-time"));
    assert!(!text.contains("Notes"));
    assert_eq!(out(&app.zv(&["item", "get", "T", "--field", "url"])), "");
}

#[test]
fn app_errors_become_exit_codes() {
    for (error, want) in [
        ("unauthorized", 3),
        ("denied", 4),
        ("outOfScope", 4),
        ("paused", 4),
        ("timeout", 4),
        ("locked", 5),
        ("notFound", 1),
        ("internal", 1),
    ] {
        let app = App::start(Box::new(
            move |_| json!({"type":"error","code":error,"message":"nope"}),
        ));
        let o = app.zv(&["ls"]);
        assert_eq!(code(&o), want, "{error}");
        assert!(err(&o).contains("nope"));
    }
}

#[test]
fn a_surprising_reply_is_reported() {
    let app = App::start(Box::new(|_| json!({"type":"ok"})));
    let o = app.zv(&["ls"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("unexpected response"));
    for args in [
        vec!["read", "zv://a/b/C"],
        vec!["copy", "zv://a/b/C"],
        vec!["projects"],
        vec!["items"],
        vec!["env", "zv://a/b"],
    ] {
        assert_eq!(code(&app.zv(&args)), 1, "{args:?}");
    }
}

#[test]
fn agents_pair_list_act_and_unpair() {
    let app = App::healthy();
    assert!(out(&app.zv(&["agent", "list"])).contains("No agents are paired"));

    let o = app.zv(&["agent", "pair", "--name", "Claude Code"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(out(&o).contains("Paired Claude Code"));
    assert!(err(&o).contains("Approve \"Claude Code\""));
    assert_eq!(app.last()["body"]["type"], "pair");

    let o = app.zv(&["agent", "pair", "--name", "claude code"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("already paired"));
    assert_eq!(code(&app.zv(&["agent", "pair", "--name", "  "])), 64);

    assert!(out(&app.zv(&["agent", "list"])).contains("Claude Code\tagt_1"));
    assert!(out(&app.zv(&["status"])).contains("1 paired"));

    let text = out(&app.zv(&["agent", "status"]));
    assert!(text.contains("Claude Code (agt_1)"));
    assert!(text.contains("ask once per 15 minutes"));
    assert!(text.contains("zv://web/development/*"));
    assert_eq!(app.last()["auth"]["agentId"], "agt_1");
    assert_eq!(app.last()["auth"]["token"], "tok-1");

    // Commands act as the only paired agent when asked to.
    let o = app.zv(&["ls", "--agent", "claude code"]);
    assert_eq!(code(&o), 0);
    assert_eq!(app.last()["auth"]["agentId"], "agt_1");
    let o = app.zv_with(&["projects"], "", &[("ZV_AGENT", "Claude Code")]);
    assert_eq!(code(&o), 0);
    assert_eq!(app.last()["auth"]["agentId"], "agt_1");
    let o = app.zv(&["ls", "--agent", "nobody"]);
    assert_eq!(code(&o), 3);

    let o = app.zv(&["agent", "unpair"]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).contains("Unpaired Claude Code"));
    assert!(out(&app.zv(&["agent", "list"])).contains("No agents are paired"));
    assert_eq!(code(&app.zv(&["agent", "status"])), 3);
}

#[test]
fn unpair_forgets_the_agent_even_if_the_app_already_did() {
    let app = App::start(Box::new(|req| {
        match req["body"]["type"].as_str().unwrap() {
            "pair" => json!({"type":"paired","agentId":"a","name":"Bot","token":"t"}),
            _ => json!({"type":"error","code":"unauthorized","message":"gone"}),
        }
    }));
    assert_eq!(code(&app.zv(&["agent", "pair", "--name", "Bot"])), 0);
    assert_eq!(code(&app.zv(&["agent", "unpair", "--agent", "Bot"])), 0);
    assert!(out(&app.zv(&["agent", "list"])).contains("No agents"));
}

#[test]
fn several_paired_agents_need_a_choice() {
    let app = App::start(Box::new(|req| {
        match req["body"]["type"].as_str().unwrap() {
            "pair" => json!({"type":"paired","agentId":format!("id-{}", req["body"]["name"]),
            "name":req["body"]["name"],"token":"t"}),
            _ => json!({"type":"list","refs":[]}),
        }
    }));
    assert_eq!(code(&app.zv(&["agent", "pair", "--name", "One"])), 0);
    assert_eq!(code(&app.zv(&["agent", "pair", "--name", "Two"])), 0);
    let o = app.zv(&["agent", "status"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("several agents"));
}

#[test]
fn the_guide_is_printed_two_ways() {
    let app = App::healthy();
    let a = out(&app.zv(&["guide"]));
    assert!(a.contains("zv://"));
    assert_eq!(a, out(&app.zv(&["help", "agents"])));
    assert_eq!(a, out(&app.zv(&["help", "guide"])));
    assert_eq!(app.requests(), 0);
}

#[test]
fn bad_usage_exits_nonzero() {
    let app = App::healthy();
    assert_ne!(code(&app.zv(&["nonsense"])), 0);
    assert_ne!(code(&app.zv(&[])), 0);
    assert_eq!(code(&app.zv(&["--version"])), 0);
}

#[test]
fn unlock_ignores_the_cloud_token() {
    let app = App::healthy();
    let o = app.zv_with(&["unlock"], "", &[("ZVAULT_TOKEN", "zvt_not_used")]);
    assert_eq!(code(&o), 0);
}

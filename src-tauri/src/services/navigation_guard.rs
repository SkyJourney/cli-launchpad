//! Navigation guard (m6-065): the webview may only be navigated within the application itself.
//!
//! Rendering untrusted HTML (M7) must never let a link navigate the main webview away: the whole
//! workspace (PTYs, file buffers) would be lost with the page. The built-in plugin hooks Tauri's
//! plugin-level `on_navigation`, which runs for every webview, including the ones JavaScript
//! creates. New windows are refused by default on all three platforms because the application
//! installs no new-window handler (see docs/architecture.md); a contract test keeps it that way.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, Url,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    Deny,
}

fn is_plain_host(url: &Url, host: &str) -> bool {
    url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// Decides whether a webview may navigate to `url`. `allow_dev` must only be set in debug builds;
/// then the origin of the configured `devUrl` is allowed too.
pub fn decide_navigation(url: &Url, dev_url: Option<&Url>, allow_dev: bool) -> NavigationDecision {
    let text = url.as_str();
    if text == "about:blank" || text == "about:srcdoc" {
        return NavigationDecision::Allow;
    }
    if url.scheme() == "tauri" && is_plain_host(url, "localhost") {
        return NavigationDecision::Allow;
    }
    if matches!(url.scheme(), "http" | "https") && is_plain_host(url, "tauri.localhost") {
        return NavigationDecision::Allow;
    }
    // Only http(s) pages can be the dev server (a `blob:` URL would inherit its origin).
    if allow_dev
        && matches!(url.scheme(), "http" | "https")
        && dev_url.is_some_and(|dev| url.origin() == dev.origin())
    {
        return NavigationDecision::Allow;
    }
    NavigationDecision::Deny
}

/// Describes a blocked URL for logs: scheme and host only, never path, query, fragment or
/// credentials (they may carry tokens or user file names).
pub(crate) fn describe_blocked(url: &Url) -> String {
    format!(
        "scheme={} host={}",
        url.scheme(),
        url.host_str().unwrap_or("-")
    )
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = webview.app_handle().config().build.dev_url.clone();
            match decide_navigation(url, dev_url.as_ref(), cfg!(debug_assertions)) {
                NavigationDecision::Allow => true,
                NavigationDecision::Deny => {
                    log::warn!("navigation_blocked {}", describe_blocked(url));
                    false
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use tauri::Url;

    use super::{decide_navigation, describe_blocked, NavigationDecision};

    fn decide(text: &str) -> NavigationDecision {
        decide_navigation(&Url::parse(text).unwrap(), None, false)
    }

    #[test]
    fn app_origins_are_allowed() {
        for text in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/?detachedSessionId=abc&handoffToken=t",
            "tauri://localhost/index.html#section",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "https://tauri.localhost/?a=1",
            "about:blank",
            "about:srcdoc",
        ] {
            assert_eq!(decide(text), NavigationDecision::Allow, "{text}");
            // Reverse: the debug switch does not change what an app origin gets.
            assert_eq!(
                decide_navigation(&Url::parse(text).unwrap(), None, true),
                NavigationDecision::Allow,
                "{text} with allow_dev"
            );
        }
    }

    #[test]
    fn external_and_dangerous_urls_are_denied() {
        let mut allowed = 0;
        for text in [
            "https://example.com/",
            "http://example.com/",
            "http://localhost:1420/",
            "http://tauri.localhost.evil.com/",
            "https://tauri.localhost@evil.com/",
            "http://user:pw@tauri.localhost/",
            "http://tauri.localhost:8080/",
            "tauri://localhost:1234/",
            "tauri://evil/",
            "tauri://localhost.evil.com/",
            "file:///C:/Windows/win.ini",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "blob:https://example.com/00000000-0000-4000-8000-000000000000",
            "ftp://tauri.localhost/",
            "about:config",
            "about:blank#x",
            "about:srcdoc?x=1",
            "ws://tauri.localhost/",
        ] {
            if decide(text) == NavigationDecision::Allow {
                allowed += 1;
                eprintln!("unexpectedly allowed: {text}");
            }
        }
        // Reverse: nothing in this list may be allowed.
        assert_eq!(allowed, 0);
    }

    #[test]
    fn dev_origin_is_allowed_only_when_the_debug_flag_is_set() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let with = |text: &str, allow_dev: bool| {
            decide_navigation(&Url::parse(text).unwrap(), Some(&dev), allow_dev)
        };

        assert_eq!(
            with("http://localhost:1420/", true),
            NavigationDecision::Allow
        );
        assert_eq!(
            with("http://localhost:1420/", false),
            NavigationDecision::Deny
        );
        assert_eq!(
            with("http://localhost:1420/?x=1#y", true),
            NavigationDecision::Allow
        );
        assert_eq!(
            with("http://localhost:1420/index.html", true),
            NavigationDecision::Allow
        );
        for text in [
            "http://localhost:1421/",
            "http://127.0.0.1:1420/",
            "https://localhost:1420/",
            "http://localhost/",
            "http://evil.com:1420/",
        ] {
            assert_eq!(with(text, true), NavigationDecision::Deny, "{text}");
        }
        // Without a configured devUrl nothing is allowed on its behalf.
        assert_eq!(
            decide_navigation(&Url::parse("http://localhost:1420/").unwrap(), None, true),
            NavigationDecision::Deny
        );
        // Reverse: the debug switch does not open other schemes, not even ones that inherit the
        // dev origin.
        assert_eq!(with("file:///etc/passwd", true), NavigationDecision::Deny);
        assert_eq!(
            with(
                "blob:http://localhost:1420/00000000-0000-4000-8000-000000000000",
                true
            ),
            NavigationDecision::Deny
        );
    }

    #[test]
    fn blocked_navigation_logs_carry_no_path_query_or_credentials() {
        let url = Url::parse("https://user:secret@example.com:8443/private/path?token=abc123#frag")
            .unwrap();
        let described = describe_blocked(&url);

        assert_eq!(described, "scheme=https host=example.com");
        for leaked in [
            "secret", "user", "private", "token", "abc123", "frag", "8443",
        ] {
            assert!(!described.contains(leaked), "{leaked}");
        }
        assert_eq!(
            describe_blocked(&Url::parse("file:///C:/Users/me/secret.txt").unwrap()),
            "scheme=file host=-"
        );
        assert_eq!(
            describe_blocked(&Url::parse("data:text/plain,hello").unwrap()),
            "scheme=data host=-"
        );
        // Reverse: a URL without a host.
        assert_eq!(
            describe_blocked(&Url::parse("about:blank").unwrap()),
            "scheme=about host=-"
        );
    }
}

use flightdeck_dashboard::app::theme::Theme;

#[test]
fn theme_resolution_cli_overrides_env() {
    assert_eq!(
        Theme::from_cli_or_env(Some("dawn"), Some("system")),
        Theme::Dawn
    );
}

#[test]
fn theme_resolution_env_overrides_default() {
    assert_eq!(Theme::from_cli_or_env(None, Some("system")), Theme::System);
    assert_eq!(
        Theme::from_cli_or_env(None, Some("pantera")),
        Theme::Pantera
    );
}

#[test]
fn theme_resolution_invalid_falls_back_to_default() {
    assert_eq!(Theme::from_cli_or_env(None, Some("bogus")), Theme::Moon);
    assert_eq!(
        Theme::from_cli_or_env(Some("nope"), Some("dawn")),
        Theme::Moon
    );
}

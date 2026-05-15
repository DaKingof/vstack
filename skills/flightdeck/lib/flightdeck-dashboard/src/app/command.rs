use std::path::PathBuf;

use futures::future::BoxFuture;

use super::msg::Msg;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotSource {
    Demo(&'static str),
    File(PathBuf),
}

pub enum Cmd {
    Render,
    RequestSnapshot(SnapshotSource),
    LogAction(String),
    Spawn(BoxFuture<'static, Msg>),
}

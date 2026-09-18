




use crate::paths;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};





pub fn init() {
    let log_dir = paths::logs_dir();
    std::fs::create_dir_all(&log_dir).ok();

    
    let file_appender = tracing_appender::rolling::daily(&log_dir, "onedesktop.log");
    let file_layer = fmt::layer()
        .json()
        .with_writer(file_appender)
        .with_filter(EnvFilter::new("info,onedesktop=trace"));

    
    let stderr_layer = fmt::layer()
        .compact()
        .with_target(true)
        .with_filter(EnvFilter::new("debug,onedesktop=trace"));

    tracing_subscriber::registry()
        .with(file_layer)
        .with(stderr_layer)
        .init();

    tracing::info!(
        target: "onedesktop.metrics",
        log_dir = %log_dir.display(),
        "Logging initialized"
    );
}
